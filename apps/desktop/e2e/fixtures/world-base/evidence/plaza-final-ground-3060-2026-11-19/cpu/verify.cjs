'use strict';
const fs=require('node:fs'),p=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto'),a=require('node:assert/strict');
const read=n=>JSON.parse(fs.readFileSync(p.join(__dirname,n))),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const scene=read('scene.json'),decals=read('decals.json'),east=read('east-lot.json'),w=read('w1.json'),c=read('corridors.json'),colliders=JSON.parse(z.gunzipSync(fs.readFileSync(p.join(__dirname,'colliders.json.gz'))));
a.equal(scene.source,w.source);a.equal(scene.source,c.sha);a.equal(scene.source,decals.source);a.equal(colliders.length,3147);a.equal(hash(JSON.stringify(colliders)),'a0487644f831456ba4802d144d452d9d9709c5b80a26384f0931545fa4d2a541');
a.equal(decals.probe.fingerprint,scene.bakedFingerprint);a.equal(decals.probe.source,'baked');a.equal(decals.probe.rays,0);
a.equal(decals.probe.items.length,26);a.equal(hash(JSON.stringify(decals.probe.items)),'2e17ad7b2de399565ed74fabc4d8deda50d25f780dde5e36d1d086d8a8539fc3');
a.equal(decals.rows.filter(r=>r.ninePass).length,22);a.equal(decals.rows.filter(r=>r.curvedException&&r.curvedSnap.atSourceDirective.pass).length,4);a(decals.rows.every(r=>r.extraGeometryInFront===0));
a.equal(w.rows.length,60);a.equal(w.rows.reduce((n,r)=>n+r.sampled,0),51036);a(w.rows.every(r=>r.sampled===r.contactCount));a.equal(w.solids.length,3);a(w.atlas.length===3&&w.atlas.every(r=>r.differentPixels===0&&r.groupObjectCount>1));
a.deepEqual(scene.stationStructures.eastAndAlley,east.terrainChecks);a.equal(east.terrainChecks.find(v=>v.placement.name==='station-exchange').hasEntry.steps,8);a(c.fourFloorComparedToR3.sameIndicesAndVertexCoordinates);
for(const name of ['town-apartment-3f','town-apartment-5f']){const cc=c.buildings[name].actualClearances;a(Math.abs(cc.slab.clips.minY-.08)<1e-5);a(Math.abs(cc.lamps.clips.minY-.0775)<1e-5);}
a.equal(scene.plaza.bark+scene.plaza.blob+scene.plaza.cards,13921);console.log('Verified joint fingerprint, 26 decals, 3147 colliders, 51036 shelf contacts, both rear corridors, east entry and 13921 plaza triangles.');
