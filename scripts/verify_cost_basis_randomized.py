#!/usr/bin/env python3
"""Run the seeded ledger campaign; persist the seed/input/stage on failure."""
import argparse
import json
import pathlib
import sys
import tempfile
import time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tests'))
from cost_basis_randomized_test import Campaign

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed',type=int,default=0)
    parser.add_argument('--cases',type=int,default=2000)
    parser.add_argument('--steps',type=int,default=80)
    parser.add_argument('--store-cases',type=int,default=300)
    parser.add_argument('--report',type=pathlib.Path)
    args=parser.parse_args()
    if args.cases<1 or args.steps<12 or not 0<=args.store_cases<=args.cases:
        parser.error('cases >= 1, steps >= 12, and 0 <= store-cases <= cases are required')
    campaign=Campaign();start=time.monotonic()
    try:
        for i in range(args.cases):
            seed=args.seed+i
            try: campaign.verify_case(seed,args.steps,store=i<args.store_cases)
            except Exception as error:
                path=pathlib.Path(tempfile.mkdtemp(prefix='cost-basis-counterexample-'))/'failure.json'
                case=campaign.last_case
                # Tuple keys are not JSON keys; rows + seed suffice to replay the oracle.
                path.write_text(json.dumps(dict(seed=seed,steps=args.steps,stage=campaign.last_stage,
                    error=str(error),rows=case['rows'],book=case['book']),indent=2))
                print(f'FAILED seed={seed} stage={campaign.last_stage}; input: {path}',flush=True)
                from cost_basis_random_reduce import reduce_case
                try:
                    reduced=reduce_case(campaign)
                    if reduced is not None:
                        path.with_name('reduced.json').write_text(json.dumps(reduced,indent=2))
                except Exception as reduction_error:
                    print(f'Reduction unavailable: {reduction_error}',flush=True)
                print(f'Replay: python scripts/verify_cost_basis_randomized.py --seed {seed} --cases 1 --steps {args.steps} --store-cases 1',flush=True)
                raise
            if (i+1)%100==0:
                print(f'{i+1}/{args.cases} seeds passed; {time.monotonic()-start:.1f}s',flush=True)
        result=dict(seed=args.seed,cases=args.cases,steps=args.steps,storeCases=args.store_cases,
                    seconds=round(time.monotonic()-start,2),coverage=dict(campaign.coverage))
        if args.report: args.report.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))
    finally: campaign.close()

if __name__=='__main__': main()
