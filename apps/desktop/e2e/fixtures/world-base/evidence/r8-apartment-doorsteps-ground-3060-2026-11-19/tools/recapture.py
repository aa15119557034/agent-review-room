"""Compare the preceding round's candidate with the current round's baseline at shared commit."""
import sys,json
from pathlib import Path
import numpy as np
from PIL import Image
old,new=map(Path,sys.argv[1:3])
commit='eb000ad5f3bd976cfbb485fe3606442c82309ab5'
for folder in (old,new):
    assert json.loads((folder/'report.json').read_bytes())['source']==commit
views={}
for first in sorted(old.glob('*.png')):
    a=np.asarray(Image.open(first).convert('RGB'),dtype='int16')
    b=np.asarray(Image.open(new/first.name).convert('RGB'),dtype='int16')
    delta=np.abs(a-b).max(axis=2)
    views[first.stem]={'changed':int((delta>0).sum()),'over2':int((delta>2).sum()),'max':int(delta.max())}
dest=Path(__file__).resolve().parents[1]/'baseline-recapture.json'
dest.write_text(json.dumps({'source':commit,'reference':'r7 photos-after','repeat':'r8 photos-before','views':views},indent=2)+'\n')
print(views)
