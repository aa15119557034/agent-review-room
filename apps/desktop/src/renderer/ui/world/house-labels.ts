/** Screen-space presentation only; never moves an avatar or changes a place. */
export interface HouseLabel {key:string;x:number;y:number;name:string;activity:string;selected:boolean}

export function arrangeHouseLabels(labels:readonly HouseLabel[],width:number,height:number):HouseLabel[]{
  const shown:{label:HouseLabel;width:number;height:number}[]=[];
  const priority=(label:HouseLabel)=>label.selected?0:label.key==="__player"?1:2;
  for(const original of [...labels].sort((a,b)=>priority(a)-priority(b))){
    // CSS clips long names to 144px. This conservative box also covers CJK and
    // mixed Latin labels without DOM measurement feedback or flicker.
    const boxWidth=Math.min(160,Math.max(70,[...original.name].length*12+18,[...original.activity].length*10+18));
    const boxHeight=original.activity?43:29;
    const x=Math.max(boxWidth/2+5,Math.min(width-boxWidth/2-5,original.x));
    const clear=(y:number)=>shown.every(box=>Math.abs(x-box.label.x)>(boxWidth+box.width)/2+5||y-boxHeight>box.label.y+5||y<box.label.y-box.height-5);
    const offsets=priority(original)<2?[0,-(boxHeight+10),boxHeight+10,-2*(boxHeight+10),2*(boxHeight+10)]:[0];
    for(const offset of offsets){const y=Math.max(boxHeight+6,Math.min(height-6,original.y+offset));if(!clear(y))continue;shown.push({label:{...original,x,y},width:boxWidth,height:boxHeight});break;}
  }
  return shown.map(box=>box.label);
}
