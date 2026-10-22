// Independent complete synthetic labels. Coordinates are fixture inputs, never production constants.
module.exports = function header(y = .05, height = .01) {
    return [['DAILY P&L',.03,.06],['FIN',.096,.02],['INSTRUMENT',.13,.08],['MARK',.299,.038],
        ['COST',.339,.035],['BASIS',.376,.036],['POS',.443,.023],['UNRLZD',.471,.049],['P&L',.522,.023],
        ['DELTA',.551,.039],['DLLRS',.592,.038],['MKT',.641,.028],['VALUE',.671,.041],
        ['AVG',.714,.028],['PRICE',.744,.035],['PTF',.795,.022],['THETA',.819,.039],
        ['LAST',.901,.033],['IMPLD',.943,.03],['VL...',.975,.024]].map(([text,x,width])=>({text,bbox:[x,y,width,height]}));
};
