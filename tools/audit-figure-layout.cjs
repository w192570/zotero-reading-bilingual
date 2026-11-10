// Read-only layout audit of existing SDTPacks. Does not generate Zotero caches.
// The JSON report is private diagnostic data, not a correctness verdict on crops.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const crypto=require('node:crypto');

async function main() {
  const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
  if(!args['--storage']||!args['--sdt-module']||!args['--output'])throw new Error('Required: --storage <directory> --sdt-module <official reader.js> --output <report.json>');
  const storage=path.resolve(args['--storage']),output=path.resolve(args['--output']);
  const relative=path.relative(storage,output);
  if(relative===''||(!path.isAbsolute(relative)&&!relative.startsWith('..'+path.sep)))throw new Error('Report must be outside the source storage directory');
  const {openStructuredDocumentTextPack}=require(path.resolve(args['--sdt-module']));
  const scope={};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../content/scripts/pdf-figure-fallback.js'),'utf8'),scope);
  const api=scope.ZRBPDFFigureFallback,documents=[];
  for(const entry of fs.readdirSync(storage,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    const folder=path.join(storage,entry.name),cache=path.join(folder,'.zotero-sdt-cache');
    if(!fs.existsSync(cache))continue;
    try {
      const pack=await openStructuredDocumentTextPack(fs.readFileSync(cache),{inflate:bytes=>zlib.inflateRawSync(bytes)});
      const structure=await pack.materialize();
      if(structure.metadata?.processor?.type!=='pdf')continue;
      const pdfs=fs.readdirSync(folder).filter(name=>name.toLowerCase().endsWith('.pdf')).map(name=>path.join(folder,name));
      const pdf=pdfs.find(file=>crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')===structure.metadata?.source?.hash);
      const blocks=api.blocks(structure.content),figures=[];
      for(const {block,ref} of blocks) {
        if(block.type!=='caption'||!/^\s*(?:fig(?:ure)?\.?\s*\d|图\s*\d)/i.test(api.text(block)))continue;
        for(const rect of block.anchor?.pageRects||[]) {
          if(!api.validRect(rect))continue;
          const native=api.hasGraphic(rect,blocks,block);
          const candidates=native?[]:api.getCropCandidates(structure,ref,rect[0]);
          const groupRef=api.captionGroup(rect,blocks,block)[0].ref.join('.');
          figures.push({ref:ref.join('.'),groupRef,page:rect[0]+1,native,candidates});
        }
      }
      documents.push({key:entry.name,pdf,cache,sourceMatches:!!pdf,figures});
    } catch(e) {documents.push({key:entry.name,error:String(e)});}
  }
  const figures=documents.flatMap(doc=>doc.figures||[]);
  const summary={documents:documents.length,errors:documents.filter(d=>d.error).length,
    captions:figures.length,native:figures.filter(f=>f.native).length,
    candidateRegions:figures.filter(f=>!f.native&&f.candidates.length).length,
    noRegion:figures.filter(f=>!f.native&&!f.candidates.length).length,
    uniqueFigures:figures.filter(f=>f.ref===f.groupRef).length,
    uniqueFallbacks:figures.filter(f=>f.ref===f.groupRef&&!f.native).length};
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({scope:'layout_only_not_pixel_or_desktop_validation',summary,documents},null,2));
  console.log(JSON.stringify(summary));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
