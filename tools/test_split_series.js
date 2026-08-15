const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0;
  for(let k=src.indexOf('{',i);k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}};

/* Lift top-level constants from index.html instead of re-typing them.
   A hand-copied constant makes the test exercise its own value: changing the
   shipped M_SERIES_GAP from 12h to 60s — which would shatter every Bo3 into
   one-game "series" — was completely invisible, and so were ORGWORDS and
   tnorm. A test that declares its own copy only ever tests itself. */
const lift=(name)=>{
  const re=new RegExp("\\bconst\\s+"+name+"\\s*=\\s*([^;]+);");
  const m=re.exec(src);
  if(!m) throw new Error("could not lift const "+name+" from index.html");
  return m[1].trim();
};
const M_SERIES_GAP=eval(lift('M_SERIES_GAP'));
eval(grab('mSplitSeries')); eval(grab('mPickSeries'));
let ok=0,fail=0;
const check=(n,g,w)=>{ if(JSON.stringify(g)===JSON.stringify(w)){ok++;console.log('  PASS  '+n);}
  else{fail++;console.log('  FAIL  '+n+'\n          got '+JSON.stringify(g)+'\n          want '+JSON.stringify(w));}};

const AUG13=Math.floor(Date.parse('2026-08-13T10:00:00Z')/1000);
const AUG21=Math.floor(Date.parse('2026-08-21T14:00:00Z')/1000);
const g=(id,t)=>({matchId:id,startTime:t,game:0});
// a Swiss Bo3 on the 13th, a playoff Bo3 rematch on the 21st, returned as one flat list 1..6
const flat=[g('a1',AUG13),g('a2',AUG13+3000),g('a3',AUG13+6800),
            g('b1',AUG21),g('b2',AUG21+3200),g('b3',AUG21+7000)];

const meetings=mSplitSeries(flat);
check('two meetings found', meetings.length, 2);
check('three games each', meetings.map(m=>m.games.length), [3,3]);
check('renumbered 1..3 within each, not 1..6',
      meetings.map(m=>m.games.map(x=>x.game)), [[1,2,3],[1,2,3]]);

check('group fixture (13 Aug) opens the FIRST meeting',
      mPickSeries(meetings,'2026-08-13T10:00:00Z').games.map(x=>x.matchId), ['a1','a2','a3']);
check('playoff fixture with no kick-off opens the LATEST',
      mPickSeries(meetings,'').games.map(x=>x.matchId), ['b1','b2','b3']);
check('playoff fixture WITH a kick-off opens its own',
      mPickSeries(meetings,'2026-08-21T14:00:00Z').games.map(x=>x.matchId), ['b1','b2','b3']);
check('an unparseable date falls back to the latest',
      mPickSeries(meetings,'not-a-date').games.map(x=>x.matchId), ['b1','b2','b3']);

// the ordinary case: they met once
const one=mSplitSeries([g('x1',AUG13),g('x2',AUG13+3000)]);
check('single meeting stays one series', one.length, 1);
check('numbering unchanged', one[0].games.map(x=>x.game), [1,2]);
check('picked regardless of date', mPickSeries(one,'').games.length, 2);
check('picked with a date too', mPickSeries(one,'2026-08-13T10:00:00Z').games.length, 2);

// hostile input
check('games with no start time do not explode',
      mSplitSeries([{matchId:'n1',startTime:null},{matchId:'n2',startTime:null}]).length>=1, true);
check('empty list', mSplitSeries([]).length, 0);
// a long Bo5 must NOT split (games hours apart, well under the 12h boundary)
const bo5=mSplitSeries([g('c1',AUG21),g('c2',AUG21+3600),g('c3',AUG21+7200),
                        g('c4',AUG21+10800),g('c5',AUG21+14400)]);
check('a five-game Bo5 stays one series', bo5.length, 1);
check('...numbered 1..5', bo5[0].games.map(x=>x.game), [1,2,3,4,5]);
console.log('\n  '+ok+' passed, '+fail+' failed');
process.exit(fail?1:0);
