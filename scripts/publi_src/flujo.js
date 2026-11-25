// ============================================================
// flujo.js — Panel de Flujo Cognitivo (v3)
//
// Dibuja la arquitectura REAL de MIIA con las dimensiones reales de cada red y
// anima el caudal de mensajes que reporta class30 en su tick de 1 s.
//
// v3 — perspectiva, estelas y bloom:
//   · PERSPECTIVA. La profundidad se hornea en las coordenadas al CONSTRUIR:
//     todo lo que viene despues (aristas, particulas, estelas) la hereda gratis.
//     Las capas se comprimen hacia el centro y suben al alejarse, que es como
//     se ve un plano mirado desde arriba y de costado.
//   · ESTELAS. La curva se muestrea hacia atras y se traza con grosor y opacidad
//     decrecientes. Sale mas barato que guardar historial de posiciones.
//   · BLOOM. Los brillos van a un canvas aparte a MEDIA resolucion, se difuminan
//     con ctx.filter y se componen en modo lighter. La media resolucion es lo que
//     hace barato el blur — y el propio desenfoque la disimula.
//
// Sigue valiendo de v2:
//   · El campo de conexiones se pre-renderiza UNA vez a un canvas offscreen.
//   · Sin tick en 6 s el panel NO finge: rotula "SIN FLUJO". Los fines de semana
//     el filtro de delta de class19 frena todo y eso es correcto, no una falla.
//
// API:  window.MIIA_FLOW.update({ msgs, feedback_cerrados, redes, senal, conf })
// ============================================================
(() => {
"use strict";

// Dimensiones reales de class23 (miia_cognitive/class23.cpp, struct MLP23):
//
//   h1 = max(4, in/2)   h2 = max(2, in/4)   salida = 1 (sigmoide)
//
// CORREGIDO 8-sep-2026. Antes decia "out = in/8" y dibujaba capas finales de
// 8/4/4 neuronas. Esa era la v1 de class23, la que terminaba en softmax(out_dim)
// y derivaba su score como sum(|a|)/out_dim — o sea, la CONSTANTE 1/out_dim.
// La v2.0 la reescribio con cabeza escalar entrenable y la salida pasó a ser 1.
// El panel siguio mostrando la arquitectura vieja: un numero plausible sobre un
// mecanismo que ya no existia, en la pantalla que se llama "arquitectura REAL".
//
// NOTA: esto dibuja class23. class24 comparte los mismos nombres de fuente pero
// tiene otra forma (inDim → 64 → 1, H fijo a proposito para dar diversidad al
// ensemble). El panel no lo distingue.
const REDES = [
  { id:"mercado",   label:"mercado|64",   capas:[64,32,16,1] },
  { id:"portfolio", label:"portfolio|32", capas:[32,16, 8,1] },
  { id:"impacto",   label:"impacto|12",   capas:[12, 6, 3,1] },
  { id:"cluster",   label:"cluster|12",   capas:[12, 6, 3,1] },
];
const FUENTES = ["class10","class7","class1","class2","class40","class44"];
const FRAC    = [0.055,0.155,0.29,0.40,0.50,0.60,0.79,0.935];

// Camara. COMPRESION = cuanto se cierra el plano al alejarse (0 = chato).
// ALTURA = cuanto sube el eje: simula mirar desde arriba.
const COMPRESION = 0.40;
const ALTURA     = 0.13;

const cv = document.getElementById("flujo-canvas");
if (!cv) return;
const ctx = cv.getContext("2d", { alpha:false });
const bl  = document.createElement("canvas");     // capa de bloom
const blx = bl.getContext("2d");

let W=0,H=0,DPR=1,S=1,nodos=[],aristas=[],particulas=[],feedbacks=[],estatico=null;
let ultimoTick = 0;
let movil = false;                 // lo fija resize(); lo lee el dibujo del EMA
const estado = { redes:{}, senal:"HOLD", conf:0.5 };
const COLOR = { in:[34,211,238], up:[52,211,153], down:[244,63,94], fb:[251,191,36] };

// ── Historial del EMA ──────────────────────────────────────────────────────
// El EMA ya modulaba el brillo de las neuronas, pero un tinte fijo no deja ver
// que el numero SE MUEVE: una red podia pasar de 0.30 a 0.95 y el panel se veia
// casi igual. Guardamos una ventana de muestras —class30 emite 1 tick por
// segundo, asi que HIST_N son HIST_N segundos de recorrido— y con eso se dibuja
// el trazo y se decide el color por tendencia.
const HIST_N = 90;
const hist = {};                   // red -> [ema...] del mas viejo al mas nuevo

function muestrearEma(){
  for(const r of REDES){
    const e=(estado.redes[r.id]||{}).ema;
    if(e==null) continue;
    const h = hist[r.id] || (hist[r.id]=[]);
    h.push(Math.max(0,Math.min(1,+e)));
    if(h.length>HIST_N) h.shift();
  }
}

// Pendiente reciente. Se compara contra la muestra de hace ~9 s y no contra la
// anterior: entre dos ticks consecutivos la diferencia casi siempre es 0 y el
// color quedaria parpadeando en gris.
function tendencia(id){
  const h=hist[id];
  if(!h||h.length<3) return 0;
  return h[h.length-1]-h[Math.max(0,h.length-10)];
}
function colorTend(t){
  return t>0.004 ? "52,211,153" : t<-0.004 ? "244,63,94" : "148,163,184";
}
function emaGlobal(){
  const vs=REDES.map(r=>(estado.redes[r.id]||{}).ema).filter(v=>v!=null);
  return vs.length ? vs.reduce((a,b)=>a+ +b,0)/vs.length : 0.5;
}
function tendGlobal(){
  const ts=REDES.map(r=>tendencia(r.id));
  return ts.reduce((a,b)=>a+b,0)/(ts.length||1);
}

// u = avance en el pipeline [0,1]. Devuelve la y proyectada y la escala de
// profundidad, que despues modula radio, grosor y opacidad.
function proy(y,u){
  const k=1-COMPRESION*u, cy=H*0.5;
  return [ cy+(y-cy)*k - ALTURA*H*u, k ];
}

function construir(){
  nodos=[]; aristas=[];
  const padY=44;
  const jit=n=>(n>24?11:n>10?6:0)*S;
  const push=(x,y,r,tipo,meta)=>(nodos.push({x,y,r,tipo,...meta}),nodos.length-1);
  const nodo=(ci,yPlano,rBase,tipo,meta)=>{
    const [y,k]=proy(yPlano,FRAC[ci]);
    return push(FRAC[ci]*W, y, rBase*S*k, tipo, {...meta,k});
  };

  const idxF=FUENTES.map((f,i)=>
    nodo(0, padY+(H-padY*2)*(i+0.5)/FUENTES.length, 2.8,"fuente",{label:f}));
  const idx19=[]; for(let i=0;i<14;i++)
    idx19.push(nodo(1, padY+(H-padY*2)*(i+0.5)/14, 1.9,"filtro",{}));

  const bandaH=(H-padY*2)/REDES.length, capasIdx=[];
  REDES.forEach((red,ri)=>{
    const y0=padY+bandaH*ri, y1=y0+bandaH;
    const porCapa=red.capas.map((n,ci)=>{
      const ids=[], alto=(y1-y0)*0.60, cy=(y0+y1)/2, j=jit(n);
      for(let q=0;q<n;q++){
        const yp = n===1?cy : cy-alto/2+alto*q/(n-1);
        const i=nodo(2+ci, yp, n>40?0.95:(n>16?1.25:1.8), "neurona",
                     {red:red.id,capa:ci});
        if(j) nodos[i].x += (Math.random()-0.5)*j;
        ids.push(i);
      }
      return ids;
    });
    capasIdx.push({red,porCapa,y0});
  });

  const i25A=nodo(6,H/2,7.5,"ensemble",{label:"class25A"});
  const i25B=nodo(7,H/2,6,"lengua",{label:"class25B"});

  const link=(a,b,t="fwd")=>aristas.push({a,b,tipo:t});
  const sample=(A,B,f)=>{for(const a of A)for(const b of B)if(Math.random()<f)link(a,b);};

  sample(idxF, idx19, 0.55);
  capasIdx.forEach(({porCapa})=>{
    sample(idx19, porCapa[0], 6*14/idx19.length/porCapa[0].length);
    for(let c=0;c<porCapa.length-1;c++){
      // Hacia la salida escalar se conecta TODO: con un solo nodo destino, un
      // muestreo al 24-52% lo dejaria con una arista o ninguna y pareceria roto.
      // Ademas es lo cierto: la ultima capa es densa hacia una sola neurona.
      const f = porCapa[c+1].length===1 ? 1
              : porCapa[c].length>32?0.11 : porCapa[c].length>12?0.24 : 0.52;
      sample(porCapa[c], porCapa[c+1], f);
    }
    porCapa[porCapa.length-1].forEach(o=>link(o,i25A));
  });
  link(i25A,i25B);
  capasIdx.forEach(({porCapa})=>
    porCapa[0].filter((_,k)=>k%4===0).forEach(n=>link(i25B,n,"fb")));

  // Banda de cada red, ya proyectada, para las etiquetas.
  construir.bandas = capasIdx.map(({red,y0})=>({ red, y: proy(y0,FRAC[2])[0] }));
  prerender();
}

function ctrl(a,b,tipo){
  if(tipo==="fb"){ const A=H-14*S; return [a.x+40*S,A,b.x-60*S,A]; }
  const m=(a.x+b.x)/2; return [m,a.y,m,b.y];
}
function bez(a,b,t,tipo){
  const [c1x,c1y,c2x,c2y]=ctrl(a,b,tipo), u=1-t;
  return [ u*u*u*a.x+3*u*u*t*c1x+3*u*t*t*c2x+t*t*t*b.x,
           u*u*u*a.y+3*u*u*t*c1y+3*u*t*t*c2y+t*t*t*b.y ];
}

function prerender(){
  estatico=document.createElement("canvas");
  estatico.width=cv.width; estatico.height=cv.height;
  const c=estatico.getContext("2d"); c.scale(DPR,DPR);
  for(const e of aristas){
    const a=nodos[e.a],b=nodos[e.b];
    // Las conexiones lejanas se atenuan igual que los nodos: es lo que le da
    // profundidad al campo entero y no solo a los puntos.
    const k=(a.k+b.k)/2;
    c.lineWidth=0.6*S*k;
    c.strokeStyle = e.tipo==="fb"
      ? `rgba(251,191,36,${0.085*k})` : `rgba(56,189,248,${0.11*k})`;
    const [c1x,c1y,c2x,c2y]=ctrl(a,b,e.tipo);
    c.beginPath(); c.moveTo(a.x,a.y);
    c.bezierCurveTo(c1x,c1y,c2x,c2y,b.x,b.y); c.stroke();
  }
}

const TRAIL=8;
function emitir(n){
  const fwd=aristas.filter(e=>e.tipo==="fwd");
  const dir = estado.senal==="SELL"?"down":estado.senal==="BUY"?"up":"in";
  for(let i=0;i<n;i++){
    const e=fwd[(Math.random()*fwd.length)|0]; if(!e) continue;
    particulas.push({e,t:0,v:0.006+Math.random()*0.011,
                     col:Math.random()<0.45?"in":dir, tipo:"fwd"});
  }
}
function emitirFb(){
  const fb=aristas.filter(e=>e.tipo==="fb");
  const e=fb[(Math.random()*fb.length)|0];
  if(e) feedbacks.push({e,t:0,v:0.0034+Math.random()*0.003,col:"fb",tipo:"fb"});
}

function estela(g,p){
  const a=nodos[p.e.a], b=nodos[p.e.b], c=COLOR[p.col], paso=0.016;
  for(let i=TRAIL;i>0;i--){
    const t0=p.t-paso*i; if(t0<0) continue;
    const t1=p.t-paso*(i-1), f=1-i/TRAIL;
    const [x0,y0]=bez(a,b,t0,p.tipo), [x1,y1]=bez(a,b,t1,p.tipo);
    g.strokeStyle=`rgba(${c[0]},${c[1]},${c[2]},${0.55*f*f})`;
    g.lineWidth=2.6*f+0.4;
    g.beginPath(); g.moveTo(x0,y0); g.lineTo(x1,y1); g.stroke();
  }
  const [x,y]=bez(a,b,p.t,p.tipo), r=p.tipo==="fb"?4:3.4;
  const rg=g.createRadialGradient(x,y,0,x,y,r);
  rg.addColorStop(0,`rgba(${c[0]},${c[1]},${c[2]},1)`);
  rg.addColorStop(1,`rgba(${c[0]},${c[1]},${c[2]},0)`);
  g.fillStyle=rg; g.beginPath(); g.arc(x,y,r,0,6.2832); g.fill();
}

let last=0, acum=0;
function frame(ts){
  const dt=Math.min(50,ts-last); last=ts;
  const vivo=(Date.now()-ultimoTick)<6000;

  ctx.fillStyle="#04060a"; ctx.fillRect(0,0,W,H);
  if(estatico) ctx.drawImage(estatico,0,0,W,H);

  // ── bloom, a media resolucion ──────────────────────────────────────────
  blx.setTransform(1,0,0,1,0,0);
  blx.clearRect(0,0,bl.width,bl.height);
  blx.scale(bl.width/W, bl.height/H);
  blx.lineCap="round";

  for(const n of nodos){
    let col=null;
    if(n.tipo==="fuente")   col="34,211,238";
    if(n.tipo==="ensemble") col = estado.senal==="SELL"?"244,63,94"
                               : estado.senal==="BUY"?"52,211,153":"148,163,184";
    if(n.tipo==="lengua")   col="168,85,247";
    if(!col) continue;
    const r=n.r*2.2;
    const g=blx.createRadialGradient(n.x,n.y,0,n.x,n.y,r);
    g.addColorStop(0,`rgba(${col},0.85)`); g.addColorStop(1,`rgba(${col},0)`);
    blx.fillStyle=g; blx.beginPath(); blx.arc(n.x,n.y,r,0,6.2832); blx.fill();
  }
  for(const p of particulas) estela(blx,p);
  for(const p of feedbacks)  estela(blx,p);

  ctx.globalCompositeOperation="lighter";
  ctx.filter=`blur(${Math.round(7*S)}px)`;
  ctx.drawImage(bl,0,0,W,H);
  ctx.filter="none";
  ctx.drawImage(bl,0,0,W,H);        // pasada nitida encima del halo
  ctx.globalCompositeOperation="source-over";

  // ── nodos ──────────────────────────────────────────────────────────────
  for(const n of nodos){
    let a=0.5,col="148,163,184";
    if(n.tipo==="fuente"){ a=0.95; col="34,211,238"; }
    if(n.tipo==="ensemble"){ a=1;
      col = estado.senal==="SELL"?"244,63,94":estado.senal==="BUY"?"52,211,153":"203,213,225"; }
    if(n.tipo==="lengua"){ a=0.9; col="168,85,247"; }
    if(n.tipo==="neurona"){
      const e=(estado.redes[n.red]||{}).ema ?? 0.5;
      a=(0.22+e*0.5)*n.k; col = e>0.5?"52,211,153":"56,189,248";
    }
    ctx.beginPath(); ctx.fillStyle=`rgba(${col},${a})`;
    ctx.arc(n.x,n.y,n.r,0,6.2832); ctx.fill();
    if(n.r>4*S){
      ctx.beginPath(); ctx.strokeStyle=`rgba(${col},0.3)`; ctx.lineWidth=1*S;
      ctx.arc(n.x,n.y,n.r+(6+Math.sin(ts/420)*2.5)*S,0,6.2832); ctx.stroke();
    }
  }

  // ── El punto verde, como medidor del EMA agregado ──────────────────────
  // class25A ya cambiaba de color con la senal (BUY/SELL/HOLD), pero no decia
  // nada del aprendizaje. Ahora el aro es un medidor: el arco vale el EMA medio
  // de las cuatro redes y el color es su tendencia. La amplitud del latido crece
  // con la velocidad del cambio, asi que una red que aprende rapido se ve
  // agitada y una estancada queda quieta — que es exactamente lo que el panel
  // no permitia distinguir.
  const nEns=nodos.find(n=>n.tipo==="ensemble");
  if(nEns){
    const eg=emaGlobal(), tg=tendGlobal(), colE=colorTend(tg);
    const amp=Math.min(3.2,Math.abs(tg)*120);
    const rr=nEns.r+((movil?10:14)+Math.sin(ts/300)*amp)*S;

    ctx.beginPath(); ctx.strokeStyle="rgba(71,85,105,0.35)"; ctx.lineWidth=2.2*S;
    ctx.arc(nEns.x,nEns.y,rr,0,6.2832); ctx.stroke();

    ctx.beginPath(); ctx.strokeStyle=`rgba(${colE},0.95)`; ctx.lineWidth=2.8*S;
    ctx.lineCap="round";
    ctx.arc(nEns.x,nEns.y,rr,-Math.PI/2,-Math.PI/2+6.2832*Math.max(0,Math.min(1,eg)));
    ctx.stroke(); ctx.lineCap="butt";

    ctx.font=((movil?8.5:9.5)*S).toFixed(1)+"px ui-monospace,monospace";
    ctx.textAlign="center";
    ctx.fillStyle=`rgba(${colE},0.95)`;
    ctx.fillText("ema "+eg.toFixed(3), nEns.x, nEns.y+rr+13*S);
    ctx.fillStyle="rgba(71,85,105,0.9)";
    ctx.fillText(tg>0.004?"aprendiendo":tg<-0.004?"retrocede":"estable",
                 nEns.x, nEns.y+rr+24*S);
    ctx.textAlign="left";
  }

  // ── etiquetas ──────────────────────────────────────────────────────────
  ctx.font=(9.5*S).toFixed(1)+"px ui-monospace,monospace";
  (construir.bandas||[]).forEach(({red,y})=>{
    const x0=W*0.29-4, yl=y+12*S;
    ctx.fillStyle="rgba(148,163,184,0.92)";
    ctx.fillText(red.label, x0, yl);
    let w=ctx.measureText(red.label).width;
    // En movil las dimensiones de capas se omiten: no entran junto al EMA, y
    // entre "32 → 16 → 8 → 4" y ver moverse el numero, lo segundo informa mas.
    if(!movil){
      const dims="  ·  "+red.capas.join(" → ");
      ctx.fillStyle="rgba(71,85,105,0.85)";
      ctx.fillText(dims, x0+w, yl);
      w+=ctx.measureText(dims).width;
    }

    // ── Recorrido del EMA ──────────────────────────────────────────────
    const h=hist[red.id]||[], e=(estado.redes[red.id]||{}).ema;
    if(e==null) return;
    const t=tendencia(red.id), col=colorTend(t);
    const spW=(movil?42:70)*S, spH=(movil?9:12)*S;
    const sx=x0+w+8*S, sb=yl+2*S;          // base del trazo

    ctx.strokeStyle="rgba(71,85,105,0.30)"; ctx.lineWidth=1*S;
    ctx.beginPath(); ctx.moveTo(sx,sb); ctx.lineTo(sx+spW,sb); ctx.stroke();

    if(h.length>1){
      // Autoescala. Con un eje fijo 0..1 estos EMA —que viven entre 0.95 y
      // 0.96— daban una linea perfectamente muerta: el movimiento existia pero
      // quedaba aplastado contra el techo. Se escala a la ventana, con un piso
      // de RANGO_MIN para que el ruido de la tercera decimal no se convierta en
      // un sismo cuando la red esta realmente quieta.
      const RANGO_MIN=0.05;
      let lo=h[0], hi=h[0];
      for(const v of h){ if(v<lo) lo=v; if(v>hi) hi=v; }
      const span=Math.max(hi-lo,RANGO_MIN), mid=(lo+hi)/2;
      lo=mid-span/2;
      const norm=v=>Math.max(0,Math.min(1,(v-lo)/span));

      // El trazo ocupa SIEMPRE el ancho completo y se desplaza cuando la
      // ventana se llena. Mapeado sobre HIST_N, los primeros 90 s dibujaban en
      // media caja y el resto quedaba como linea gris suelta.
      const paso = h.length>1 ? spW/(h.length-1) : 0;
      ctx.strokeStyle=`rgba(${col},0.85)`; ctx.lineWidth=1.3*S;
      ctx.beginPath();
      for(let i=0;i<h.length;i++){
        const px=sx+paso*i, py=sb-spH*norm(h[i]);
        i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
      }
      ctx.stroke();
      const ey=sb-spH*norm(h[h.length-1]);
      ctx.fillStyle=`rgba(${col},1)`;
      ctx.beginPath(); ctx.arc(sx+spW,ey,1.9*S,0,6.2832); ctx.fill();
    }

    ctx.font=((movil?8:8.5)*S).toFixed(1)+"px ui-monospace,monospace";
    ctx.fillStyle=`rgba(${col},0.95)`;
    ctx.fillText((t>0.004?"▲":t<-0.004?"▼":"·")+" "+(+e).toFixed(3),
                 sx+spW+7*S, yl);
    ctx.font=(9.5*S).toFixed(1)+"px ui-monospace,monospace";
  });
  ctx.font=(8.5*S).toFixed(1)+"px ui-monospace,monospace";
  ctx.fillStyle="rgba(71,85,105,0.9)";
  [["fuentes",0.055],["class19",0.155],["class25A",0.79],["class25B",0.935]]
    .forEach(([t,f])=>ctx.fillText(t, f*W-t.length*2.4*S, H-9*S));

  for(let i=particulas.length-1;i>=0;i--){
    const p=particulas[i]; p.t+=p.v*dt/16; if(p.t>=1) particulas.splice(i,1);
  }
  for(let i=feedbacks.length-1;i>=0;i--){
    const p=feedbacks[i]; p.t+=p.v*dt/16; if(p.t>=1) feedbacks.splice(i,1);
  }

  if(!vivo){ acum+=dt; if(acum>700){ acum=0; emitir(1); } }
  const badge=document.getElementById("flujo-estado");
  if(badge){ badge.textContent = vivo?"LIVE":"SIN FLUJO";
             badge.style.color  = vivo?"#10b981":"#64748b"; }

  requestAnimationFrame(frame);
}

function resize(){
  DPR=Math.max(2,Math.min(3,window.devicePixelRatio||1));
  const box=cv.parentElement.getBoundingClientRect();
  // Piso de 720 px SOLO en escritorio. En un celular de 375 forzaba el dibujo a
  // 720 y el navegador lo escalaba a la mitad: todo ilegible. Abajo de 700 se
  // usa el ancho real y el grafico se compacta en vez de encogerse.
  movil = box.width > 0 && box.width < 700;
  W = movil ? Math.max(320, box.width) : Math.max(720, box.width);
  // Panel propio: usa el alto disponible del contenedor, acotado por proporcion
  // para que no vuelva a quedar en franja como cuando era una tarjeta.
  // En vertical se permite mas alto que ancho, que es la forma de la pantalla.
  const dispo=(box.height>240?box.height:0) || Math.round(W*0.62);
  H = movil
    ? Math.round(Math.max(W*0.95, Math.min(W*1.6, dispo || W*1.2)))
    : Math.round(Math.max(W*0.44, Math.min(W*0.72, dispo)));
  S=Math.max(movil?0.55:0.9, Math.min(1.7, W/1000));
  cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR); cv.style.height=H+"px";
  ctx.setTransform(DPR,0,0,DPR,0,0);
  // El blur de pantalla completa es lo mas caro del render. En movil se baja la
  // resolucion de la capa: el propio desenfoque disimula la perdida.
  const escBloom = movil ? 0.38 : 0.55;
  bl.width=Math.round(W*escBloom); bl.height=Math.round(H*escBloom);
  construir();
}

window.MIIA_FLOW = {
  update(p){
    if(!p) return;
    ultimoTick=Date.now();
    // Una muestra por tick (1 s). El muestreo va aca y no en frame(): a 60 fps
    // la ventana de HIST_N seria de segundo y medio y no se veria ningun cambio.
    if(p.redes){ estado.redes=p.redes; muestrearEma(); }
    if(p.senal) estado.senal=String(p.senal);
    if(p.conf!=null) estado.conf=+p.conf;
    if(p.msgs) emitir(Math.min(40,p.msgs));
    if(p.feedback_cerrados)
      for(let i=0;i<Math.min(10,p.feedback_cerrados);i++) emitirFb();
  },
  redibujar: resize
};

window.addEventListener("resize",()=>{clearTimeout(window.__flujoRT);
  window.__flujoRT=setTimeout(resize,180);});
resize(); requestAnimationFrame(frame);
})();
