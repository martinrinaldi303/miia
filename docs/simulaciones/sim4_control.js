'use strict';
// SIM 4 - control del umbral por TASA DE EMISION (reemplazo del trinquete).
// Cada EMISION_CADA decisiones mira la ventana de las ultimas EMISION_VENTANA
// y mueve el umbral con paso proporcional al error. Se prueba con tres
// dispersiones posibles de la distancia al neutro, porque en z no sabemos
// todavia cuanto se va a mover.
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function gaussF(rnd){return()=>{let u=0,v=0;while(u===0)u=rnd();while(v===0)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};}
const UMBRAL_MIN=0.28,UMBRAL_MAX=0.70,MARGEN_MIN=0.02,MARGEN_MAX=0.20;
const CADA=200,VENTANA=1000,PASO=0.005,BANDA=0.05,OBJ=0.25,MIN_MUESTRAS=200;
function margen(u){return Math.min(MARGEN_MAX,Math.max(MARGEN_MIN,(u-UMBRAL_MIN)/(UMBRAL_MAX-UMBRAL_MIN)*MARGEN_MAX));}
function correr(sd,u0,dias,semilla){
  const rnd=mulberry32(semilla),g=gaussF(rnd);
  let u=u0;const win=[];const horas=[];let emitTot=0,n=0,ajustes=0;
  const total=20000*dias;
  for(let i=1;i<=total;i++){
    const d=sd*g();                       // distancia al neutro (en z ya centrada)
    const emit=Math.abs(d)>=margen(u);
    win.push(emit);if(win.length>VENTANA)win.shift();
    if(emit)emitTot++;n++;
    if(i%CADA===0&&win.length>=MIN_MUESTRAS){
      const tasa=win.reduce((a,b)=>a+(b?1:0),0)/win.length;
      const err=tasa-OBJ;
      const paso=Math.min(6,Math.max(1,Math.abs(Math.log(Math.max(tasa,0.002)/OBJ))/Math.LN2))*PASO;
      if(tasa>OBJ*(1+BANDA)){u=Math.min(UMBRAL_MAX,u+paso);ajustes++;}
      else if(tasa<OBJ*(1-BANDA)){u=Math.max(UMBRAL_MIN,u-paso);ajustes++;}
    }
    if(i%Math.round(20000/24)===0)horas.push({u,tasa:emitTot/n});
  }
  // tasa del ultimo dia
  return {u,horas,ajustes};
}
console.log('=== SIM 4 - control por tasa de emision (objetivo 25%) ===');
for(const sd of [0.03,0.059,0.12]){
  for(const u0 of [0.42,0.70]){
    const r=correr(sd,u0,3,99);
    const h=r.horas;
    console.log('sd='+sd.toFixed(3)+' arranca en '+u0.toFixed(2)+
      ' -> umbral h1 '+h[0].u.toFixed(3)+' | h6 '+h[5].u.toFixed(3)+
      ' | h24 '+h[23].u.toFixed(3)+' | h72 '+h[71].u.toFixed(3)+
      ' | margen final '+margen(r.u).toFixed(3)+
      ' | emision acumulada '+(h[71].tasa*100).toFixed(1)+'%');
  }
}
console.log('');
console.log('Estabilidad: umbral hora a hora el tercer dia (sd=0.059, arranca 0.70):');
const r=correr(0.059,0.70,3,99);
console.log('  '+r.horas.slice(48,72).map(x=>x.u.toFixed(3)).join(' '));
console.log('');
console.log('Que pasa si el sistema EMPEORA de verdad (la regla vieja subia el umbral):');
console.log('  el control nuevo no lo toca: la tasa de emision no cambia porque el acierto baje.');
console.log('  El acierto se sigue logueando; mover el umbral por acierto es lo que');
console.log('  generaba 153 subidas contra 1 bajada con un sistema de 50%.');
