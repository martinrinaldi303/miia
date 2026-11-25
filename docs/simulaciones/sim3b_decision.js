'use strict';
// SIM 3b - igual que la 3, pero con las redes CORRELACIONADAS (se mueven juntas
// cuando se mueve el instrumento). rho se calibra para que el desvio de la
// distancia al neutro de 0,059, que es el medido en el chequeo del viernes.
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
let rnd=mulberry32(4242);
function gauss(){let u=0,v=0;while(u===0)u=rnd();while(v===0)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const RED={
  'class21':{mu:0.545,sd:0.0269},'class22':{mu:0.545,sd:0.0269},
  'class23':{mu:0.545,sd:0.0269},'class24':{mu:0.545,sd:0.0269},
  'class21/mercado':{mu:0.7365,sd:0.0063},'class22/mercado':{mu:0.6720,sd:0.0098},
  'class23/mercado':{mu:0.5745,sd:0.0891},'class24/mercado':{mu:0.5635,sd:0.0919},
  'class21/portfolio':{mu:0.881,sd:0.03},'class22/portfolio':{mu:0.894,sd:0.03},
  'class23/portfolio':{mu:0.450,sd:0.03},'class24/portfolio':{mu:0.243,sd:0.03},
};
const RUEDA=['class21','class22','class23','class24','class21/mercado','class22/mercado','class23/mercado','class24/mercado'];
const NOCHE=['class21/portfolio','class22/portfolio','class23/portfolio','class24/portfolio'];
const NEUTRO=0.6026, SD_MEDIDO=0.059;
function mods(keys){const m={};for(const k of keys){const mo=k.split('/')[0];(m[mo]=m[mo]||[]).push(k);}return m;}
// score_i = mu_i + sd_i*(rho*S + sqrt(1-rho^2)*e_i) -> la marginal de cada red queda como se midio
function corrida(keys,N,regla,margen,rho,semilla){
  rnd=mulberry32(semilla||4242);
  const porMod=mods(keys);const ds=[];let buy=0,sell=0;
  const k1=rho,k2=Math.sqrt(1-rho*rho);
  for(let i=0;i<N;i++){
    const S=gauss();const x={};const eBare=gauss();
    for(const k of keys){const e=(k.indexOf('/')<0)?eBare:gauss();x[k]=RED[k].mu+RED[k].sd*(k1*S+k2*e);}
    let acc=0,n=0;
    for(const mo in porMod){let v=0;
      for(const k of porMod[mo])v+=(regla==='z')?(x[k]-RED[k].mu)/RED[k].sd:x[k];
      acc+=v/porMod[mo].length;n++;}
    const s=acc/n,d=(regla==='z')?s:s-NEUTRO;
    ds.push(d);if(d>=margen)buy++;else if(d<=-margen)sell++;
  }
  const media=ds.reduce((a,b)=>a+b,0)/N;
  const sd=Math.sqrt(ds.reduce((a,b)=>a+(b-media)*(b-media),0)/N);
  return {buy:buy/N,sell:sell/N,hold:1-(buy+sell)/N,media,sd};
}
// calibrar rho para reproducir el desvio medido
let rho=0.5,mejor=1e9;
for(let r=0;r<=0.99;r+=0.01){const s=corrida(RUEDA,20000,'crudo',0.067,r,7).sd;
  if(Math.abs(s-SD_MEDIDO)<mejor){mejor=Math.abs(s-SD_MEDIDO);rho=r;}}
console.log('=== SIM 3b - la decision, con la dispersion real ===');
console.log('correlacion entre redes calibrada: rho='+rho.toFixed(2)+
            ' -> desvio de la distancia al neutro '+corrida(RUEDA,50000,'crudo',0.067,rho,7).sd.toFixed(4)+' (medido 0,059)');
console.log('');
console.log('REGLA DE HOY - promedio de scores CRUDOS contra el neutro 0,6026');
for(const [nom,keys] of [['rueda (peladas + mercado)',RUEDA],['cerrado (4 de portfolio)',NOCHE]]){
  for(const [um,m] of [['0,42',0.067],['0,70 (el de ahora)',0.20]]){
    const r=corrida(keys,200000,'crudo',m,rho,7);
    console.log('  '+nom.padEnd(26)+' umbral '+um.padEnd(18)+' centro '+r.media.toFixed(4).padStart(8)+
                ' -> BUY '+(r.buy*100).toFixed(1)+'%  SELL '+(r.sell*100).toFixed(1)+'%  HOLD '+(r.hold*100).toFixed(1)+'%');
  }
}
console.log('');
console.log('CAMBIO B - cada red en z contra su propia media (el neutro desaparece)');
for(const [nom,keys] of [['rueda (peladas + mercado)',RUEDA],['cerrado (4 de portfolio)',NOCHE]]){
  const r=corrida(keys,200000,'z',0.62,rho,7);
  console.log('  '+nom.padEnd(26)+' umbral en z 0,62   '+' centro '+r.media.toFixed(4).padStart(8)+
              ' -> BUY '+(r.buy*100).toFixed(1)+'%  SELL '+(r.sell*100).toFixed(1)+'%  HOLD '+(r.hold*100).toFixed(1)+'%');
}
console.log('');
const a=corrida(RUEDA,100000,'crudo',0.067,rho,7),b=corrida(NOCHE,100000,'crudo',0.067,rho,7);
console.log('Cuanto corre el CENTRO al cambiar la composicion (sin que el mercado diga nada):');
console.log('  regla de hoy: '+a.media.toFixed(4)+' -> '+b.media.toFixed(4)+
            '  = '+(Math.abs(b.media-a.media)/SD_MEDIDO).toFixed(2)+' desvios de la senal');
const c=corrida(RUEDA,100000,'z',0.62,rho,7),d=corrida(NOCHE,100000,'z',0.62,rho,7);
console.log('  cambio B:     '+c.media.toFixed(4)+' -> '+d.media.toFixed(4)+
            '  = '+(Math.abs(d.media-c.media)/c.sd).toFixed(2)+' desvios');
