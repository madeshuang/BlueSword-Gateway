/* eslint-disable */
// 移植自 blue-3d/model.js（程序化生成的 3D 网格 + 表情），仅把全局导出改成 ES module。
const exportsHost = {};
/* blue: authored volumetric mascot geometry. Front +Z, up +Y. No image planes. */
(function (global) {
  'use strict';
  var RX = 1.36, RY = 1.08, RZ = .99;
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function signedPow(x, p) { return Math.sign(x) * Math.pow(Math.abs(x), p); }
  function frontProfile(z) { return .35 * z + .65 * Math.sin(z * Math.PI / 2); }
  function smoothstep(a,b,x) { var t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t); }

  function create(THREE) {
    if (!THREE || !THREE.BufferGeometry) throw new Error('blue requires Three.js.');
    var group = new THREE.Group();
    group.name = 'blue_character';
    group.userData = { name: 'blue', assetType: 'volumetric-3d-mesh', frontAxis: '+Z', upAxis: '+Y' };
    var visorCY = .055, visorN = 2.3, visorA = 1.063, visorB = .630;
    var materials = {
      shell: new THREE.MeshPhysicalMaterial({ color: 0xdce5e9, metalness: .48, roughness: .31, clearcoat: .16, clearcoatRoughness: .30, envMapIntensity: .85 }),
      chin: new THREE.MeshPhysicalMaterial({ color: 0xc2d0d7, metalness: .66, roughness: .31, clearcoat: .16, clearcoatRoughness: .3 }),
      trim: new THREE.MeshPhysicalMaterial({ color: 0x465960, metalness: .64, roughness: .31, clearcoat: .12, clearcoatRoughness: .27 }),
      gasket: new THREE.MeshStandardMaterial({ color: 0x101b21, metalness: .12, roughness: .52 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x071018, metalness: .08, roughness: .235, clearcoat: .24, clearcoatRoughness: .23, specularIntensity: .30, reflectivity: .42, ior: 1.45, envMapIntensity: .62 }),
      badge: new THREE.MeshPhysicalMaterial({ color: 0x009caf, emissive: 0x006876, emissiveIntensity: .11, metalness: .30, roughness: .26, clearcoat: .14, clearcoatRoughness: .24 }),
      badgeEdge: new THREE.MeshPhysicalMaterial({ color: 0x005866, metalness: .52, roughness: .29 }),
      eye: new THREE.MeshStandardMaterial({ color: 0x103f45, emissive: 0x64eeee, emissiveIntensity: 1.8, metalness: .02, roughness: .28, toneMapped: false }),
      eyeEdge: new THREE.MeshStandardMaterial({ color: 0x059aab, emissive: 0x00b6c7, emissiveIntensity: .62, roughness: .3, toneMapped: false }),
      seam: new THREE.MeshStandardMaterial({ color: 0x667d84, metalness: .35, roughness: .49 }),
      rearPanel: new THREE.MeshPhysicalMaterial({ color: 0xd8e2e6, metalness: .46, roughness: .33, clearcoat: .16, clearcoatRoughness: .30 }),
      rearLed: new THREE.MeshStandardMaterial({ color: 0x83f8ff, emissive: 0x21ccd6, emissiveIntensity: 1.3, roughness: .2, toneMapped: false })
    };
    Object.keys(materials).forEach(function (key) { materials[key].name = 'blue_' + key; });

    function surfaceZ(x, y, side, offset) {
      var u = y / RY;
      var fx = 1 + .025 * u, fz = 1 - .035 * u;
      var q = 1 - u * u - Math.pow(x / (RX * fx), 2);
      var z = Math.sqrt(Math.max(.00001, q));
      if ((side || 1) > 0) z = frontProfile(z);
      return (side || 1) * (RZ * fz * z + (offset || 0));
    }
    function surfaceSlope(x,y,side){
      var u=y/RY,fx=1+.025*u,fz=1-.035*u;
      var q=Math.max(.00001,1-u*u-Math.pow(x/(RX*fx),2)),z=Math.sqrt(q);
      var qx=-2*x/(RX*RX*fx*fx);
      var qy=-2*u/RY+2*x*x*(.025/RY)/(RX*RX*fx*fx*fx);
      var f=(side||1)>0?frontProfile(z):z;
      var derivative=(side||1)>0?.35+.65*Math.PI/2*Math.cos(z*Math.PI/2):1;
      return[(side||1)*RZ*fz*derivative*qx/(2*z),(side||1)*RZ*((-.035/RY)*f+fz*derivative*qy/(2*z))];
    }
    function boundary(a, b, n, angle) {
      return [a * signedPow(Math.cos(angle), 2 / n), b * signedPow(Math.sin(angle), 2 / n)];
    }
    function mesh(name, geometry, material, parent) {
      var item = new THREE.Mesh(geometry, material); item.name = name;
      item.castShadow = true; item.receiveShadow = true;
      (parent || group).add(item); return item;
    }
    function geometryFrom(positions, indices) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
      return geo;
    }
    function surfaceDisk(a, b, cy, n, offset, side, rings, segments) {
      rings = rings || 32; segments = segments || 160; side = side || 1;
      var positions = [0, cy, surfaceZ(0, cy, side, offset)], indices = [];
      for (var k = 1; k <= rings; k++) {
        var radius = k / rings;
        for (var j = 0; j < segments; j++) {
          var xy = boundary(a, b, n, j * Math.PI * 2 / segments);
          var x = xy[0] * radius, y = cy + xy[1] * radius;
          positions.push(x, y, surfaceZ(x, y, side, offset));
        }
      }
      function tri(a0, b0, c0) { if (side > 0) indices.push(a0, b0, c0); else indices.push(a0, c0, b0); }
      for (var j0 = 0; j0 < segments; j0++) tri(0, 1 + j0, 1 + (j0 + 1) % segments);
      for (var ring = 1; ring < rings; ring++) {
        var inner = 1 + (ring - 1) * segments, outer = 1 + ring * segments;
        for (var s = 0; s < segments; s++) {
          var next = (s + 1) % segments;
          tri(inner + s, outer + s, outer + next); tri(inner + s, outer + next, inner + next);
        }
      }
      return geometryFrom(positions, indices);
    }
    function surfaceRim(profiles, cy, n, side, segments) {
      side = side || 1; segments = segments || 160;
      var positions = [], indices = [];
      profiles.forEach(function (p) {
        for (var j = 0; j < segments; j++) {
          var xy = boundary(p[0], p[1], n, j * Math.PI * 2 / segments);
          var y = cy + xy[1]; positions.push(xy[0], y, surfaceZ(xy[0], y, side, p[2]));
        }
      });
      for (var k = 0; k < profiles.length - 1; k++) {
        for (var s = 0; s < segments; s++) {
          var a = k * segments + s, b = k * segments + (s + 1) % segments;
          var c = (k + 1) * segments + s, d = (k + 1) * segments + (s + 1) % segments;
          if (side > 0) indices.push(a, b, c, b, d, c); else indices.push(a, c, b, b, c, d);
        }
      }
      return geometryFrom(positions, indices);
    }
    function capsuleShape(width, height) {
      var sh = new THREE.Shape(), rad = width / 2, half = height / 2 - rad;
      sh.moveTo(-rad, -half); sh.lineTo(-rad, half);
      sh.absarc(0, half, rad, Math.PI, 0, true); sh.lineTo(rad, -half);
      sh.absarc(0, -half, rad, 0, -Math.PI, true); sh.closePath(); return sh;
    }
    function roundRectangle(width, height, radius) {
      var w=width/2,h=height/2,r=Math.min(radius,w,h),s=new THREE.Shape();
      s.moveTo(-w+r,-h);s.lineTo(w-r,-h);s.quadraticCurveTo(w,-h,w,-h+r);
      s.lineTo(w,h-r);s.quadraticCurveTo(w,h,w-r,h);s.lineTo(-w+r,h);
      s.quadraticCurveTo(-w,h,-w,h-r);s.lineTo(-w,-h+r);s.quadraticCurveTo(-w,-h,-w+r,-h);s.closePath();return s;
    }
    function projectExtrusion(shape, cx, cy, side, offset, depth, bevel, rotation) {
      var original = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1, curveSegments: 20 });
      var sourcePos=original.getAttribute('position'),sourceNormal=original.getAttribute('normal'),sourceUV=original.getAttribute('uv'),sourceIndex=original.getIndex();
      var packed=[],groups=[];
      function readVertex(i){
        if(sourceIndex)i=sourceIndex.getX(i);
        return[sourcePos.getX(i),sourcePos.getY(i),sourcePos.getZ(i),sourceNormal.getX(i),sourceNormal.getY(i),sourceNormal.getZ(i),sourceUV?sourceUV.getX(i):0,sourceUV?sourceUV.getY(i):0];
      }
      function distance2(a,b){return Math.pow(a[0]-b[0],2)+Math.pow(a[1]-b[1],2)+Math.pow(a[2]-b[2],2);}
      function midpoint(a,b){return a.map(function(v,i){return(v+b[i])*.5;});}
      function subdivide(a,b,c0,depth0){
        var ab=distance2(a,b),bc=distance2(b,c0),ca=distance2(c0,a),longest=Math.max(ab,bc,ca);
        if(longest<=.05*.05||depth0>=12){packed.push(a,b,c0);return;}
        if(longest===ab){var m=midpoint(a,b);subdivide(a,m,c0,depth0+1);subdivide(m,b,c0,depth0+1);}
        else if(longest===bc){var m1=midpoint(b,c0);subdivide(a,b,m1,depth0+1);subdivide(a,m1,c0,depth0+1);}
        else{var m2=midpoint(c0,a);subdivide(a,b,m2,depth0+1);subdivide(m2,b,c0,depth0+1);}
      }
      // Cap triangles must be fine enough before bending onto the shell. A single
      // large chord triangle would sink into the body and leave only thin edges.
      original.groups.forEach(function(g){
        var start=packed.length;
        for(var ti=g.start;ti<g.start+g.count;ti+=3)subdivide(readVertex(ti),readVertex(ti+1),readVertex(ti+2),0);
        groups.push({start:start,count:packed.length-start,materialIndex:g.materialIndex});
      });
      var positions=[],normals=[],uvs=[],c=Math.cos(rotation||0),s=Math.sin(rotation||0);
      var baseZ = surfaceZ(cx, cy, side, offset);
      packed.forEach(function(vertex){
        var xx=vertex[0],yy=vertex[1],zz=vertex[2];
        var px = xx*c - yy*s, py = xx*s + yy*c;
        var qu=(cy+py)/RY;
        var surfaceQ=1-qu*qu-Math.pow((cx+px)/(RX*(1+.025*qu)),2);
        if(surfaceQ < 0)throw new Error('blue detail lies beyond the shell surface: '+surfaceQ);
        positions.push(px,py,surfaceZ(cx+px,cy+py,side,offset)+(side||1)*zz-baseZ);
        var slope=surfaceSlope(cx+px,cy+py,side);
        var nx=vertex[3]*c-vertex[4]*s,ny=vertex[3]*s+vertex[4]*c,nz=vertex[5];
        var normal=new THREE.Vector3(nx-(side||1)*slope[0]*nz,ny-(side||1)*slope[1]*nz,(side||1)*nz).normalize();
        normals.push(normal.x,normal.y,normal.z);uvs.push(vertex[6],vertex[7]);
      });
      var geo=new THREE.BufferGeometry();
      geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geo.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      groups.forEach(function(g){geo.addGroup(g.start,g.count,g.materialIndex);});
      original.dispose();
      // Reflecting extrusion depth for rear parts reverses handedness. Reverse
      // triangle winding as well, so vent and LED caps face the outside rear.
      if (side < 0) {
        var reversed = [];
        var count = positions.length/3;
        for (var t = 0; t < count; t += 3) {
          reversed.push(t,t+2,t+1);
        }
        geo.setIndex(reversed);
      }
      // Analytically transformed smooth normals are retained across the newly
      // subdivided cap triangles; recomputing face normals would facet the glazing.
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      return { geometry: geo, z: baseZ };
    }

    // Closed 3D shell: front, back and lateral volumes remain real from every view.
    var shellGeo = new THREE.SphereGeometry(1, 160, 112);
    var sp = shellGeo.getAttribute('position');
    for (var v = 0; v < sp.count; v++) {
      var sy = sp.getY(v), sz = sp.getZ(v);
      var px=sp.getX(v)*RX*(1+.025*sy),py=sy*RY;
      var pz=(sz>=0?frontProfile(sz):sz)*RZ*(1-.035*sy);
      if(sz>0){
        // Depress the real front shell beneath the glazing. This makes the visor
        // an inset assembly with a thin seam, while the complete shell stays closed.
        var edge=Math.pow(Math.pow(Math.abs(px/visorA),visorN)+Math.pow(Math.abs((py-visorCY)/visorB),visorN),1/visorN);
        pz-=.038*(1-smoothstep(.98,1.04,edge));
      }
      sp.setXYZ(v,px,py,pz);
    }
    sp.needsUpdate = true; shellGeo.computeVertexNormals();shellGeo.computeBoundingBox();shellGeo.computeBoundingSphere();
    var shell = mesh('silver_closed_shell',shellGeo,materials.shell);

    // The curved visor has a genuinely beveled rim, not a rectangle floating on a ball.
    mesh('visor_recess_gasket',surfaceRim([[1.078,.645,.001],[1.073,.640,-.008],[1.060,.627,-.016]],visorCY,visorN,1,192),materials.gasket);
    mesh('machined_visor_bezel',surfaceRim([[1.075,.642,.002],[1.071,.638,.004],[1.067,.634,-.003],[visorA,visorB,-.012]],visorCY,visorN,1,192),materials.trim);
    var visorGlass=mesh('curved_black_glass',surfaceDisk(visorA,visorB,visorCY,visorN,-.011,1,40,192),materials.glass);
    visorGlass.userData.component='curved-opaque-glass';

    // Lower shell joint wraps the complete body and remains legible through a turn.
    var seamPoints=[];
    for(var si=0;si<=256;si++){
      var phi=si/256*Math.PI*2,front=Math.max(0,Math.cos(phi));
      var yy=-.52-.190*Math.pow(front,1.5),u=yy/RY,radius=Math.sqrt(1-u*u);
      var xx=RX*(1+.025*u)*radius*Math.sin(phi),rawZ=radius*Math.cos(phi);
      var zz=RZ*(1-.035*u)*(rawZ>=0?frontProfile(rawZ):rawZ);
      var norm=new THREE.Vector3(xx/(RX*RX),yy/(RY*RY),zz/(RZ*RZ)).normalize();
      seamPoints.push(new THREE.Vector3(xx,yy,zz).addScaledVector(norm,.0017));
    }
    mesh('continuous_shell_joint',new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seamPoints),256,.0018,6,false),materials.seam);

    // Raised two-part teal mark. Beveled, volumetric and conformed to the curved crown.
    var emblem=new THREE.Group();emblem.name='raised_teal_chevrons';group.add(emblem);
    function emblemPiece(name,points,cx,cy){
      var shape=new THREE.Shape();shape.moveTo(points[0][0],points[0][1]);
      for(var k=1;k<points.length;k++)shape.lineTo(points[k][0],points[k][1]);shape.closePath();
      var data=projectExtrusion(shape,cx,cy,1,.006,.023,.005,0);
      var m=mesh(name,data.geometry,[materials.badge,materials.badgeEdge],emblem);m.position.set(cx,cy,data.z);return m;
    }
    emblemPiece('teal_mark_main',[[-.290,.240],[-.100,.120],[.000,-.090],[.285,-.275],[.060,-.145],[-.140,-.050]],.76,.70);
    emblemPiece('teal_mark_echo',[[-.160,.180],[.000,.060],[.190,-.230],[.020,-.110]],.91,.71);

    // Black shapes are shallow modeled recesses; the rear shell itself stays closed.
    var rearPanelCY=-.12;
    mesh('rear_service_panel',surfaceDisk(.28,.215,rearPanelCY,3.3,.003,-1,16,96),materials.rearPanel);
    mesh('rear_service_seam',surfaceRim([[.283,.218,.002],[.28,.215,.004]],rearPanelCY,3.3,-1,96),materials.seam);
    for(var row=0;row<2;row++){
      var vy=.285+row*.060,vd=projectExtrusion(roundRectangle(.34,.017,.0085),0,vy,-1,.002,.002,.001,0);
      var vent=mesh('rear_vent_'+(row+1),vd.geometry,materials.gasket);vent.position.set(0,vy,vd.z);
    }
    var rearLedData=projectExtrusion(roundRectangle(.13,.021,.0105),0,-.12,-1,.008,.003,.0015,0);
    var rearLed=mesh('rear_status_light',rearLedData.geometry,materials.rearLed);rearLed.position.set(0,-.12,rearLedData.z);

    // Independent 3D eye components. Each visible form is a curved, beveled mesh.
    function happyShape(){
      var s=new THREE.Shape();s.moveTo(-.115,-.024);s.bezierCurveTo(-.088,.056,-.049,.113,.002,.113);
      s.bezierCurveTo(.056,.113,.094,.051,.115,-.026);s.bezierCurveTo(.133,-.091,.081,-.109,.042,-.065);
      s.bezierCurveTo(.011,-.022,-.011,-.022,-.045,-.066);s.bezierCurveTo(-.086,-.110,-.137,-.090,-.115,-.024);s.closePath();return s;
    }
    function restingShape(){
      var s=new THREE.Shape();s.moveTo(-.13,.02);s.quadraticCurveTo(0,-.055,.13,.02);s.quadraticCurveTo(.146,.029,.137,.004);
      s.quadraticCurveTo(0,-.101,-.137,.004);s.quadraticCurveTo(-.146,.029,-.13,.02);s.closePath();return s;
    }
    var eyeGroups=[],eyeParts=[];
    [-.46,.46].forEach(function(cx,index){
      var cy=.085,eyeGroup=new THREE.Group();eyeGroup.name=index?'eye_right':'eye_left';group.add(eyeGroup);
      var forms={capsule:capsuleShape(.165,.370),happy:happyShape(),rest:restingShape()};
      var handles={};
      Object.keys(forms).forEach(function(name){
        var data=projectExtrusion(forms[name],cx,cy,1,-.002,.004,.004,-.16);
        var part=mesh((index?'R':'L')+'_eye_'+name,data.geometry,[materials.eye,materials.eyeEdge],eyeGroup);
        part.position.z=data.z;part.visible=name==='capsule';part.castShadow=false;part.receiveShadow=false;handles[name]=part;
      });
      eyeGroup.position.set(cx,cy,0);
      eyeGroup.userData={baseX:cx,baseY:cy,forms:handles};eyeGroups.push(eyeGroup);eyeParts.push(handles);
    });

    var gaze={x:0,y:0}, lastState='idle';
    function setGaze(x,y){gaze.x=clamp(Number(x)||0,-1,1);gaze.y=clamp(Number(y)||0,-1,1);}
    function updateExpression(state,time,level){
      state=state||'idle';time=Number.isFinite(time)?time:0;level=clamp(Number(level)||0,0,1);
      var happy=state==='success'||state==='speaking',sleep=state==='sleep';
      var form=sleep?'rest':happy?'happy':'capsule';
      var phase=((time+.6)%4.9+4.9)%4.9,blink=phase<.16?Math.max(.055,Math.abs(Math.cos(phase/.16*Math.PI))):1;
      if(sleep)blink=1;
      eyeGroups.forEach(function(eye,index){
        Object.keys(eyeParts[index]).forEach(function(key){eyeParts[index][key].visible=key===form;});
        var lookX=gaze.x*.032,lookY=gaze.y*.027;
        if(state==='thinking'){lookX+=Math.sin(time*.85)*.026;lookY+=.055;}
        if(state==='executing'){lookX+=Math.sin(time*2.2)*.025;}
        if(sleep){lookX=0;lookY=-.025;}
        var bx=eye.userData.baseX,by=eye.userData.baseY;
        eye.position.set(bx+lookX,by+lookY,surfaceZ(bx+lookX,by+lookY,1,0)-surfaceZ(bx,by,1,0));
        var sy=blink;
        if(state==='thinking')sy*=index?.76:.96;
        if(state==='clarify')sy*=index?.62:1.02;
        if(state==='executing')sy*=.84;
        if(state==='error')sy*=index?.92:1.08;
        if(state==='speaking')sy*=1+Math.sin(time*5)*.025+level*.075;
        eye.scale.set(1+level*.035,sy,1);
      });
      materials.eye.emissiveIntensity=sleep?.54:state==='speaking'?1.85+level*.45:1.8;
      materials.eyeEdge.emissiveIntensity=sleep?.22:.62+level*.2;
      materials.rearLed.emissiveIntensity=sleep?.35:state==='thinking'?.8+Math.sin(time*3)*.2:1.15+level*.2;
      lastState=state;
    }
    updateExpression('idle',0,0);
    var stats={meshes:0,vertices:0,triangles:0};
    group.traverse(function(object){if(object.isMesh){stats.meshes++;var p=object.geometry.getAttribute('position');stats.vertices+=p?p.count:0;stats.triangles+=(object.geometry.index?object.geometry.index.count:(p?p.count:0))/3;}});
    function dispose(){var geos=new Set();group.traverse(function(o){if(o.isMesh&&o.geometry)geos.add(o.geometry);});geos.forEach(function(g){g.dispose();});Object.keys(materials).forEach(function(k){materials[k].dispose();});}
    return { group:group, eyes:eyeGroups, updateExpression:updateExpression, getModelGroup:function(){return group;}, stats:stats, materials:materials, setGaze:setGaze, dispose:dispose, dimensions:{width:2.72,height:2.16,depth:1.98}, getState:function(){return lastState;} };
  }
  global.BlueModel={create:create,version:'3.0.0',description:'Closed 3D mesh with curved visor, beveled emissive eyes, raised badge and modeled rear.'};
})(exportsHost);
export const BlueModel = exportsHost.BlueModel
