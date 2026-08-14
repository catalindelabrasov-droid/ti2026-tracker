// Pull the real functions out of index.html and replay the two defects.
const fs=require('fs');
const src=fs.readFileSync('index.html','utf8');
const grab=(name)=>{
  const i=src.indexOf('function '+name+'(');
  if(i<0) throw new Error('not found: '+name);
  let d=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} }
};
const ORGWORDS=/\b(gaming|esports?|e-sports|club|team|the|ti|20\d\d)\b/g;
const tnorm=(s)=>String(s||"").replace(/\s+/g," ").trim().toLowerCase();
const tkey=(s)=>tnorm(s).replace(/[.\-_'"]/g," ").replace(ORGWORDS," ").replace(/\s+/g," ").trim();
eval(grab('fxDecided')); eval(grab('chooseFixture')); eval(grab('findFixture'));

let ok=0,fail=0;
const check=(n,got,want)=>{ if(JSON.stringify(got)===JSON.stringify(want)){ok++;console.log('  PASS  '+n);}
  else {fail++;console.log('  FAIL  '+n+'\n          got '+JSON.stringify(got)+'\n          want '+JSON.stringify(want));} };

const fx=(id,a,b,sa,sb,status,bo)=>({id,bestOf:bo||3,status,teamA:{name:a,score:sa},teamB:{name:b,score:sb}});

console.log('-- DEFECT 1: rematch ENDS, stale live entry must not hit the finished group card');
{
  // after pass 1 both fixtures are decided
  const list=[fx('gs-r1m1','OG','Team Spirit',2,0,'completed'),
              fx('me-r1m1','Team Spirit','OG',2,0,'completed')];
  const hit=findFixture(list,'Team Spirit','OG',{requireOpen:true});
  check('live pass routes NOWHERE when every fixture is finished', hit, null);
}
console.log('-- ...but a genuinely live game still routes');
{
  const list=[fx('gs-r1m1','OG','Team Spirit',2,0,'completed'),
              fx('me-r1m1','Team Spirit','OG',null,null,'upcoming')];
  const hit=findFixture(list,'Team Spirit','OG',{requireOpen:true});
  check('routes to the open playoff fixture', hit&&list[hit.i].id, 'me-r1m1');
  check('flipped correct', hit.flipped, false);
}
console.log('-- DEFECT 2: both fixtures unscored, feed newest-first');
{
  const list=[fx('gs-r1m1','OG','Team Spirit',null,null,'upcoming'),
              fx('me-r1m1','Team Spirit','OG',null,null,'upcoming')];
  const claimed=new Set();
  // oldest first, as the fix now sorts them
  const older=findFixture(list,'OG','Team Spirit',{claimed}); claimed.add(older.i);
  const newer=findFixture(list,'Team Spirit','OG',{claimed}); claimed.add(newer.i);
  check('older series -> group fixture', list[older.i].id, 'gs-r1m1');
  check('newer series -> playoff fixture', list[newer.i].id, 'me-r1m1');
  check('two series never share one fixture', older.i!==newer.i, true);
}
console.log('-- a third series with only two fixtures must not overwrite either');
{
  const list=[fx('gs-r1m1','OG','Team Spirit',null,null,'upcoming'),
              fx('me-r1m1','Team Spirit','OG',null,null,'upcoming')];
  const claimed=new Set([0,1]);
  check('nothing left to claim -> null', findFixture(list,'OG','Team Spirit',{claimed}), null);
}
console.log('-- REGRESSION: single fixture, the ordinary case');
{
  const list=[fx('gs-r1m1','OG','Team Spirit',null,null,'upcoming')];
  check('resolves with no opts', findFixture(list,'OG','Team Spirit')&&0, 0);
  check('resolves for a live pass', findFixture(list,'OG','Team Spirit',{requireOpen:true})&&0, 0);
  const done=[fx('gs-r1m1','OG','Team Spirit',2,0,'completed')];
  check('series pass may still touch a finished fixture', findFixture(done,'OG','Team Spirit')&&0, 0);
  check('live pass may NOT', findFixture(done,'OG','Team Spirit',{requireOpen:true}), null);
  check('reversed argument order sets flipped', findFixture(list,'Team Spirit','OG').flipped, true);
  check('unknown pairing -> null', findFixture(list,'Nobody','Nowhere'), null);
  check('TBD ignored', findFixture([fx('x','TBD','TBD',null,null,'upcoming')],'TBD','TBD'), null);
}
console.log('-- stripped-key fallback keeps working');
{
  const list=[fx('gs-r1m1','Aurora Gaming','Iron Wing TI 2026',null,null,'upcoming')];
  const h=findFixture(list,'Aurora','Iron Wing');
  check('name variants still match', h&&list[h.i].id, 'gs-r1m1');
  const done=[fx('gs-r1m1','Aurora Gaming','Iron Wing TI 2026',2,0,'completed')];
  check('...and a live pass will not touch it once finished',
        findFixture(done,'Aurora','Iron Wing',{requireOpen:true}), null);
}
console.log('\n  '+ok+' passed, '+fail+' failed');
process.exit(fail?1:0);
