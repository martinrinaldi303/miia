'use strict';
// SIM 1 - Regla de credito: capa 1 (vieja) vs capa 2 (nueva), y las dos juntas.
// Reglas copiadas de class25A.cpp (actualizar/actualizarPrefijo/actualizarEvento)
// y de class43.js (redDominante por z-score con > estricto y orden alfabetico).
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
let rnd = mulberry32(20260912);
function gauss(){let u=0,v=0;while(u===0)u=rnd();while(v===0)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

const MODS=['class21','class22','class23','class24'];
const FUENTES=['cluster','impacto','mercado','portfolio'];
const KEYS=[];
for(const m of MODS){KEYS.push(m);for(const f of FUENTES)KEYS.push(m+'/'+f);}
KEYS.push('class44');

function nuevoW(){const w={};for(const k of KEYS)w[k]=1/KEYS.length;return w;}

// ---- CAPA 1 (regla vieja, class25A.cpp:400) ----
function actualizar(w,red,ok){
  if(!(red in w))w[red]=0.25;
  const d=ok?0.05:-0.03;
  w[red]=Math.min(0.50,Math.max(0.10,w[red]+d*(1-w[red])));
  let t=0;for(const k in w)t+=w[k];
  if(t>0)for(const k in w)w[k]/=t;
}
function actualizarPrefijo(w,base,ok){
  const objs=Object.keys(w).filter(k=>k===base||k.startsWith(base+'/'));
  for(const k of (objs.length?objs:[base]))actualizar(w,k,ok);
}
// ---- CAPA 2 (regla nueva, class25A.cpp:449) ----
const ETA_OK=0.01,ETA_ERR=0.006,MEZCLA=0.0005,PISO_REL=0.05;
function actualizarEvento(w,ups){
  if(!ups.length)return;
  let masa=0,n=0;
  for(const [k] of ups)if(k in w){masa+=w[k];n++;}
  const alta=n?masa/n:0.25;
  for(const [k] of ups)if(!(k in w)){w[k]=alta;masa+=alta;}
  if(!(masa>0))return;
  const nuevo={};let suma=0;
  for(const [k,ok] of ups){const v=w[k]*(ok?1+ETA_OK:1-ETA_ERR);nuevo[k]=v;suma+=v;}
  if(!(suma>0))return;
  for(const k in nuevo)nuevo[k]*=masa/suma;
  const cant=Object.keys(nuevo).length, media=masa/cant;
  for(const k in nuevo)nuevo[k]=(1-MEZCLA)*nuevo[k]+MEZCLA*media;
  const piso=PISO_REL*masa/cant;
  let levantado=0;const alzadas=new Set();
  for(const [k,ok] of ups)if(ok&&nuevo[k]<piso){levantado+=piso-nuevo[k];nuevo[k]=piso;alzadas.add(k);}
  if(levantado>0){let resto=0;for(const k in nuevo)if(!alzadas.has(k))resto+=nuevo[k];
    if(resto>levantado)for(const k in nuevo)if(!alzadas.has(k))nuevo[k]*=(resto-levantado)/resto;}
  for(const k in nuevo)w[k]=nuevo[k];
}

// ---- Composicion de la ventana (medida en el chequeo del 11-sep) ----
// Rueda: las 4 claves peladas (MISMO score, seccion 4.1) + las 4 de mercado.
// Cerrado: una sola familia (el sample de redis mostro las 4 de portfolio).
function presentes(rueda){
  if(rueda)return MODS.concat(MODS.map(m=>m+'/mercado'));
  const fam=['cluster','impacto','portfolio'][Math.floor(rnd()*3)];
  return MODS.map(m=>m+'/'+fam);
}
const TALENTO='class24/mercado';  // la unica con ventaja real
function pDe(k,conTalento){return (conTalento&&k===TALENTO)?0.55:0.50;}

// class43.redDominante: z propio de cada red, > estricto, orden alfabetico.
// Las 4 peladas comparten score -> comparten z -> empatan -> gana class21.
const RED_Z_MIN=0.5;
function redDominante(zs,signo){
  let mejor='',mejorZ=-Infinity;
  for(const k of Object.keys(zs).sort()){const zd=signo*zs[k];if(zd>mejorZ){mejorZ=zd;mejor=k;}}
  return mejorZ<RED_Z_MIN?'':mejor;
}
function zsDe(keys){
  const zBare=gauss();const zs={};
  for(const k of keys)zs[k]=(k.indexOf('/')<0)?zBare:gauss();
  return zs;
}
const CAPA2_Z_MIN=0.25;
function eventoCapa2(w,keys,conTalento){
  const zs=zsDe(keys);const dir=rnd()<0.5?1:-1;const ups=[];
  for(const k of keys){
    if(Math.abs(zs[k])<CAPA2_Z_MIN)continue;         // zona muerta
    ups.push([k,rnd()<pDe(k,conTalento)]);
  }
  actualizarEvento(w,ups);
}
function eventoCapa1(w,conTalento){
  const keys=presentes(true);                         // el camino en memoria solo corre en rueda
  const zs=zsDe(keys);const signo=rnd()<0.5?1:-1;
  const red=redDominante(zs,signo);
  if(!red){eventoCapa2(w,keys,conTalento);return null;} // red vacia -> cae a capa 2
  actualizarPrefijo(w,red,rnd()<pDe(red,conTalento));
  return red;
}

// ---- Corrida ----
const VERIF_DIA=5000;           // verificaciones por dia (ritmo del jueves)
const FRAC_CAPA1=0.45;          // las que verifica el camino en memoria (2.226 medidas el viernes)
const FRAC_RUEDA_CAPA2=0.30;    // 6,5 h de rueda sobre 24
function correr(modo,dias,conTalento,semilla){
  rnd=mulberry32(semilla);
  const w=nuevoW();const serie=[];const creditos={};
  for(let d=0;d<dias;d++){
    for(let i=0;i<VERIF_DIA;i++){
      const porCapa1=(modo!=='solo2')&&(rnd()<FRAC_CAPA1);
      if(porCapa1&&modo!=='solo2'){
        const r=eventoCapa1(w,conTalento);
        if(r)creditos[r]=(creditos[r]||0)+1;
      }else if(modo==='solo1'){
        // sin capa 2: el resto de las verificaciones no toca los pesos
      }else{
        eventoCapa2(w,presentes(rnd()<FRAC_RUEDA_CAPA2),conTalento);
      }
    }
    serie.push(cuota(w,TALENTO));
  }
  return {w,serie,creditos};
}
// Cuota DENTRO del modulo en rueda: es lo que decide con voto parejo.
function cuota(w,k){const m=k.split('/')[0];return w[k]/(w[m]+w[k]);}
function fmt(x,n){return Number(x).toFixed(n===undefined?4:n);}

console.log('=== SIM 1 - regla de credito. 10 dias, 5.000 verificaciones/dia ===');
console.log('Red con ventaja REAL: class24/mercado acierta 55%; todas las demas, 50%.');
console.log('Metrica: cuota de esa red DENTRO de su modulo (con voto parejo, es lo que decide).');
console.log('');
const modos=[['solo1','solo capa 1 (lo del viernes)'],['mixto','capa 1 + capa 2 (hoy)'],['solo2','solo capa 2 (cambio A)']];
for(const [modo,nombre] of modos){
  const con=correr(modo,10,true,777);
  const sin=correr(modo,10,false,777);
  console.log(nombre);
  console.log('  cuota de class24/mercado en su modulo: dia 1 '+fmt(con.serie[0])+
              ' | dia 5 '+fmt(con.serie[4])+' | dia 10 '+fmt(con.serie[9]));
  console.log('  la MISMA red sin ventaja (todas 50%):  dia 1 '+fmt(sin.serie[0])+
              ' | dia 5 '+fmt(sin.serie[4])+' | dia 10 '+fmt(sin.serie[9]));
  const sep=con.serie[9]-sin.serie[9];
  console.log('  separacion talento vs azar al dia 10: '+fmt(sep)+(Math.abs(sep)<0.02?'   <- indistinguible':''));
  // dispersion de las 5 claves de class21 (el prefijo las aplana)
  const c21=['class21'].concat(FUENTES.map(f=>'class21/'+f)).map(k=>con.w[k]);
  console.log('  claves de class21 (min..max): '+fmt(Math.min(...c21),5)+' .. '+fmt(Math.max(...c21),5));
  const mn=Math.min(...Object.values(con.w)),mx=Math.max(...Object.values(con.w));
  console.log('  peso minimo / maximo del archivo: '+mn.toExponential(2)+' / '+fmt(mx));
  console.log('');
}
