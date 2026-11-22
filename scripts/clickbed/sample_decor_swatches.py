"""Samples decor swatches from the supplied board catalog (Transforms / Kronospan decors).

Usage (needs PyMuPDF and Pillow: `pip install pymupdf pillow`):
    python -I scripts/clickbed/sample_decor_swatches.py         "../lib/upholstery colors/Transforms_Katalog_Plyt_Meblowych_Premium_2026.pdf" OUT_DIR

Every catalog page shows decor images with the decor code ("8685 SM") on the line directly below and
the Polish name on the next line. For each image this writes OUT_DIR/<code>.jpg (256 px crop of the
image centre, used as a preview texture) and OUT_DIR/swatches.json with the code, Polish name, catalog
group and the average colour. The catalog itself notes that colours are indicative only.
Only the swatches used by the shop's decors are copied to public/textures/decors (see build_bed_options.py).
"""
import pymupdf,sys,json,io,re
from PIL import Image
pdf,outdir=sys.argv[1],sys.argv[2]
d=pymupdf.open(pdf);res=[]
for pi,p in enumerate(d):
    words=p.get_text('words')
    header=' '.join(w[4] for w in words if w[1]<50 and w[0]>300)
    for info in p.get_image_info(xrefs=True):
        x0,y0,x1,y1=info['bbox']
        if info['width']<300 or (x1-x0)<100: continue
        below=[w for w in words if 0<=w[1]-y1<=14 and abs(w[0]-x0)<(x1-x0) and w[0]>=x0-1 and w[2]<=x1+1]
        below.sort(key=lambda w:w[0])
        line2=[w for w in words if 14<w[1]-y1<=30 and w[0]>=x0-1 and w[2]<=x1+1]; line2.sort(key=lambda w:w[0])
        if len(below)<2: continue
        code=' '.join(w[4] for w in below)
        name=' '.join(w[4] for w in line2)
        pix=p.get_pixmap(clip=pymupdf.Rect(x0,y0,x1,y1),dpi=110)
        img=Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
        w,h=img.size; core=img.crop((int(w*.1),int(h*.1),int(w*.9),int(h*.9)))
        avg=core.resize((1,1),Image.Resampling.BOX).getpixel((0,0))
        key=re.sub(r'[^A-Za-z0-9]+','-',code).strip('-')
        tex=core.resize((256,256),Image.Resampling.LANCZOS); tex.save(f'{outdir}/{key}.jpg',quality=82)
        res.append({'code':code,'namePl':name,'group':header,'page':pi+1,'hex':'#%02X%02X%02X'%avg,'file':key+'.jpg'})
json.dump(res,open(outdir+'/swatches.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
print(len(res)); 
for r in res[:5]+res[-5:]: print(r)
from collections import Counter; print(Counter(r['group'] for r in res))
