"""Archive policy layer for the workspace database admin page.

Phase 0 scope (see CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md): pure,
deterministic candidate rules and the frozen storage-metric vocabulary. No
SQLite, no I/O, no clock reads — callers inject `now`. The batch state
machine, shard schema, and manifest plumbing arrive in later phases and must
build on these exact rules rather than reimplementing them.

Candidate semantics are storage-lifecycle only. Nothing in this module reads
business payload fields: an expired option inside a payload never makes its
document a candidate. The only two candidate classes are

1. non-current revisions of a live document that fall outside the retention
   rule (current + most recent N + last-save-per-UTC-day inside the daily
   window) — the same rule `PortfolioStore.prune_revisions` applies today;
2. whole soft-deleted documents whose recovery grace period has elapsed
   (strictly more than `archive_deleted_after_days` days since deletion).
"""

from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Defaults (config keys live under [portfolio_store]; the retention and
# vacuum keys are the EXISTING ones — archival must not grow a second set of
# truth for them). Auto-run stays off until the manual flow has survived a
# release cycle (plan section 8.4).
# ---------------------------------------------------------------------------

DEFAULT_ARCHIVE_ENABLED = True
DEFAULT_ARCHIVE_AUTO_RUN = False
DEFAULT_ARCHIVE_DELETED_AFTER_DAYS = 30
DEFAULT_ARCHIVE_MAX_ROWS_PER_BATCH = 500
DEFAULT_ARCHIVE_MAX_PAYLOAD_BYTES_PER_BATCH = 64 * 1024 * 1024
DEFAULT_ARCHIVE_COMMIT_MAX_ROWS = 25
DEFAULT_ARCHIVE_COMMIT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
DEFAULT_ARCHIVE_ROLLOVER_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_ARCHIVE_PLAN_TTL_SECONDS = 900
DEFAULT_RECOVERY_SNAPSHOT_KEEP = 5
DEFAULT_RECOVERY_SNAPSHOT_KEEP_DAYS = 14
DEFAULT_RECOVERY_SNAPSHOT_REUSE_SECONDS = 900
DEFAULT_MAINTENANCE_LEASE_TTL_SECONDS = 60
DEFAULT_MAINTENANCE_LEASE_HEARTBEAT_SECONDS = 15

# ---------------------------------------------------------------------------
# Frozen storage-metric vocabulary (plan section 3.3 / phase 0 item 4).
# Every stats response, candidate preview, and manifest uses these names and
# formulas; the admin page must never blur logical, allocated, reclaimable,
# and on-disk sizes into one number.
# ---------------------------------------------------------------------------

# Canonical UTF-8 byte count of a TEXT payload column. SQLite length() on
# TEXT counts characters, which under-reports multi-byte content; the CAST
# forces byte semantics. This is the only sanctioned backfill formula for
# workspace_revisions.payload_bytes.
PAYLOAD_BYTES_SQL = 'length(CAST(payload_json AS BLOB))'

STORAGE_METRIC_FORMULAS = {
    'logicalPayloadBytes': 'SUM(workspace_revisions.payload_bytes) over rows in the active DB',
    'allocatedDbBytes': 'PRAGMA page_count * PRAGMA page_size',
    'reclaimableBytes': 'PRAGMA freelist_count * PRAGMA page_size',
    'walBytes': 'size of <db>-wal on disk, 0 when absent',
    'shmBytes': 'size of <db>-shm on disk, 0 when absent',
    'dbFileBytes': 'size of <db> on disk',
}


def assemble_storage_metrics(*, page_count, page_size, freelist_count,
                             logical_payload_bytes, db_file_bytes,
                             wal_bytes=0, shm_bytes=0):
    """Assemble the frozen metric dict from raw PRAGMA / stat inputs.

    Missing inputs must be surfaced as None by the caller ("unavailable"),
    never coerced to 0 — 0 is a measurement, not an error state."""
    def _int_or_none(value):
        return None if value is None else int(value)

    page_count = _int_or_none(page_count)
    page_size = _int_or_none(page_size)
    freelist_count = _int_or_none(freelist_count)
    return {
        'logicalPayloadBytes': _int_or_none(logical_payload_bytes),
        'allocatedDbBytes': (
            None if page_count is None or page_size is None
            else page_count * page_size
        ),
        'reclaimableBytes': (
            None if freelist_count is None or page_size is None
            else freelist_count * page_size
        ),
        'walBytes': _int_or_none(wal_bytes),
        'shmBytes': _int_or_none(shm_bytes),
        'dbFileBytes': _int_or_none(db_file_bytes),
    }


# ---------------------------------------------------------------------------
# Candidate rules
# ---------------------------------------------------------------------------

def _parse_utc(value, field):
    if not isinstance(value, str) or not value:
        raise ValueError(f'{field} must be a non-empty ISO-8601 UTC string')
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f'{field} is not ISO-8601: {value!r}') from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalized_now(now):
    if not isinstance(now, datetime):
        raise ValueError('now must be a datetime')
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def compute_revision_candidates(revisions, *, current_revision,
                                keep_recent=None, keep_daily_days=None, now):
    """Split one live document's revisions into keep / archive-candidate sets.

    `revisions` is an iterable of dicts with at least `revision` (int) and
    `savedAtUtc` (ISO UTC string); extra keys (hash, bytes) pass through
    untouched so callers can build manifests from the result. The keep rule
    is intentionally identical to PortfolioStore._prune_document:

    - the current revision is ALWAYS kept (hard invariant, checked first);
    - the most recent `keep_recent` revisions (by revision number) are kept;
    - beyond those, the last save of each UTC day is kept while that day is
      on or after `now - keep_daily_days`;
    - everything else is a candidate.

    Deterministic: same inputs, same output, no wall clock. Raises ValueError
    when `current_revision` is missing from `revisions` — that is corruption,
    not a policy decision.
    """
    # Mirror the store's clamps exactly so rule parity is provable.
    keep_recent = max(1, int(keep_recent if keep_recent is not None
                             else _default_keep_recent()))
    keep_daily_days = max(0, int(keep_daily_days if keep_daily_days is not None
                                 else _default_keep_daily_days()))
    now = _normalized_now(now)
    current_revision = int(current_revision)

    rows = []
    seen = set()
    for entry in revisions:
        revision = int(entry['revision'])
        if revision in seen:
            raise ValueError(f'duplicate revision {revision}')
        seen.add(revision)
        _parse_utc(entry['savedAtUtc'], 'savedAtUtc')  # validate early
        rows.append(dict(entry, revision=revision))
    if current_revision not in seen:
        raise ValueError(
            f'current revision {current_revision} is missing from revisions'
        )

    rows.sort(key=lambda row: row['revision'], reverse=True)
    cutoff_date = (now - timedelta(days=keep_daily_days)).date().isoformat()

    keep_reasons = {current_revision: 'current'}
    for row in rows[:keep_recent]:
        keep_reasons.setdefault(row['revision'], 'recent')
    last_per_day = {}
    for row in rows[keep_recent:]:
        day = row['savedAtUtc'][:10]
        if day >= cutoff_date:
            existing = last_per_day.get(day)
            if existing is None or row['revision'] > existing:
                last_per_day[day] = row['revision']
    for revision in last_per_day.values():
        keep_reasons.setdefault(revision, 'daily_anchor')

    kept, candidates = [], []
    for row in rows:
        reason = keep_reasons.get(row['revision'])
        if reason is not None:
            kept.append(dict(row, reason=reason))
        else:
            candidates.append(dict(row, reason='beyond_retention'))
    return {'kept': kept, 'candidates': candidates}


def compute_deleted_document_candidates(documents, *,
                                        archive_deleted_after_days=DEFAULT_ARCHIVE_DELETED_AFTER_DAYS,
                                        now):
    """Split documents into whole-document archive candidates and kept docs.

    A document is a candidate if and only if it is soft-deleted and STRICTLY
    more than `archive_deleted_after_days` days have elapsed since
    `deletedAtUtc` — at exactly the boundary it is still inside the grace
    period. Live documents are never candidates here regardless of any
    payload content (expiry dates are business data, not lifecycle data).
    """
    grace = timedelta(days=max(0, int(archive_deleted_after_days)))
    now = _normalized_now(now)

    kept, candidates = [], []
    seen = set()
    for entry in documents:
        document_id = entry['documentId']
        if document_id in seen:
            raise ValueError(f'duplicate documentId {document_id}')
        seen.add(document_id)
        deleted_at = entry.get('deletedAtUtc')
        if deleted_at is None:
            kept.append(dict(entry, reason='not_deleted'))
            continue
        deleted_at_parsed = _parse_utc(deleted_at, 'deletedAtUtc')
        if now - deleted_at_parsed > grace:
            candidates.append(dict(entry, reason='grace_elapsed'))
        else:
            kept.append(dict(entry, reason='grace_period'))
    return {'kept': kept, 'candidates': candidates}


def _default_keep_recent():
    # Late import keeps this module free of a hard dependency cycle while
    # still sourcing the single existing retention default.
    from portfolio_store import DEFAULT_REVISION_KEEP_RECENT
    return DEFAULT_REVISION_KEEP_RECENT


def _default_keep_daily_days():
    from portfolio_store import DEFAULT_REVISION_KEEP_DAILY_DAYS
    return DEFAULT_REVISION_KEEP_DAILY_DAYS
