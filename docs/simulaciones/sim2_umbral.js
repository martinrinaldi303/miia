'use strict';
// SIM 2 - El umbral de class25A (class25A.cpp:1411). Regla exacta:
// cada 50 decisiones, si hay >=20 resultados: acc<45% -> +0.03 ; acc>65% -> -0.02
// ventana = ultimos 100 outcomes (class25A.cpp:552), clamp [0.28, 0.70], arranca en 0.42.
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const DECIS_DIA=20000;   // medido: decisiones=14150 en 16,7 h
const FB_DIA=5000;       // verificaciones que vuelven por dia
function correr(p,dias,semilla){
  const rnd=mulberry32(semilla);
  let umbral=0.42,decis=0,hist=[],techo=0,recalibs=0,subio=0,bajo=0;
  const porHora=[];
  const total=DECIS_DIA*dias, fbCada=DECIS_DIA/FB_DIA;
  let hastaFb=fbCada;
  for(let i=1;i<=total;i++){
    decis++;
    if(i>=hastaFb){hist.push(rnd()<p);if(hist.length>100)hist.shift();hastaFb+=fbCada;}
    if(decis%50===0&&hist.length>=20){
      recalibs++;
      const acc=hist.reduce((a,b)=>a+(b?1:0),0)/hist.length;
      if(acc<0.45){umbral=Math.min(0.70,umbral+0.03);subio++;}
      else if(acc>0.65){umbral=Math.max(0.28,umbral-0.02);bajo++;}
    }
    if(umbral>=0.699)techo++;
    if(i%Math.round(DECIS_DIA/24)===0)porHora.push(umbral);
  }
  return {umbral,porHora,techo:techo/total,recalibs,subio,bajo};
}
function margen(u){return Math.min(0.20,Math.max(0.02,(u-0.28)/(0.70-0.28)*0.20));}
function erfc(x){const z=Math.abs(x),t=1/(1+z/2);
  const r=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+t*(-0.82215223+t*0.17087277)))))))));
  return x>=0?r:2-r;}
function pNormMayor(x,mu,sd){return 0.5*erfc((x-mu)/(sd*Math.SQRT2));}
console.log('=== SIM 2 - el umbral ===');
console.log('dia | p=50% (sin habilidad) | p=52% | p=60% (muy bueno)');
const a=correr(0.50,3,11),b=correr(0.52,3,11),c=correr(0.60,3,11);
for(const h of [1,3,6,12,24,48,72]){
  console.log('  hora '+String(h).padStart(2)+'  '+a.porHora[h-1].toFixed(3)+'   '+b.porHora[h-1].toFixed(3)+'   '+c.porHora[h-1].toFixed(3));
}
console.log('');
console.log('tiempo en el techo 0,70 (3 dias): p=50% '+(a.techo*100).toFixed(1)+'% | p=52% '+(b.techo*100).toFixed(1)+'% | p=60% '+(c.techo*100).toFixed(1)+'%');
console.log('recalibraciones que SUBIERON / BAJARON el umbral (p=50%): '+a.subio+' / '+a.bajo);
console.log('');
console.log('Que emite con cada umbral (distancia al neutro medida: sd=0.059, media -0.012):');
for(const u of [0.42,0.50,0.60,0.70]){
  const m=margen(u);
  const buy=pNormMayor(m,-0.012,0.059), sell=pNormMayor(m,0.012,0.059);
  console.log('  umbral '+u.toFixed(2)+' -> margen '+m.toFixed(3)+
              ' | BUY '+(buy*100).toFixed(1)+'%  SELL '+(sell*100).toFixed(1)+
              '%  HOLD '+((1-buy-sell)*100).toFixed(1)+'%');
}
