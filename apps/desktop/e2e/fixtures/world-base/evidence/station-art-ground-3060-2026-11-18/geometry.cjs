module.exports = async function stats() {
  const T=await import('three'),w=window.worldBase,station=w.station,city=w.city;
  const terrainChecks=city.placements.filter(p=>p.type==='station-art').map(p=>{
    const root=city.root, site=root.getObjectByName(p.name), box=new T.Box3().setFromObject(site), centre=p.center;
    const cleared=city.vegetationClearAreas.find(r=>r.name===p.name);
    return {placement:p,registeredForClearing:cleared,worldMeshBox:[box.min.toArray(),box.max.toArray()],hasEntry:city.stats.connections.stairs.find(s=>s.name===p.name+'-entry')};
  });
  function weather(root) {
    const results=[];
    root.traverse(mesh=>{
      const v=mesh.geometry?.attributes.wxMask;
      if(!v?.count)return;
      const names=[];for(let p=mesh;p&&p!==root.parent;p=p.parent)if(p.name)names.unshift(p.name);
      results.push([names.join('/'),v.getY(0),v.getZ(0)]);
    });return results;
  }
  const portal=city.laundryPortal;
  return {fingerprint:w.cpuFingerprint,deskBake:w.weatheringDecals.plan.fingerprint,runtimeDecals:w.weatheringDecals.stats,terrainChecks,
    stationArt:city.stats.stationArt,colliders:station.physics.items,treeStats:station.ctx.sakuraStats,
    allStairs:city.stats.connections.stairs,clearAreas:city.vegetationClearAreas,vegetation:city.vegetationClear,scope:city.stats.limitation,
    weather:{city:weather(city.root),skyline:weather(w.skyline.root),stats:w.weathering.stats},
    portal:portal&&{placed:portal.getWorldPosition(new T.Vector3()).toArray(),material:portal.material.name,inReceivers:w.weathering.wallMaterials.has(portal.material)},
    roots:[city.root.getObjectByName('town-house-0')?.visible,Boolean(city.root.getObjectByName('Shell')),Boolean(city.root.getObjectByName('Front_cassette'))],
    errors:w.errors};
};
