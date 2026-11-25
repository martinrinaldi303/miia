// cola_acotada.js — cola FIFO con tope duro (1-oct-2026)
//
// Función pura, sin dependencias, para que se pueda probar sin importar class30
// (que arrastra class14 y class42, y esos se conectan a MySQL al cargarse).
//
// Por qué existe: la cola de class30 hacia el Python (`pyQueue`) no tenía tope.
// Entra una decisión de class25A por cada ventana (~16.000 por día en rueda) y
// sale UNA cada 90 s (BUFFER_INTERVAL_MS), o sea 960 por día. La diferencia se
// quedaba en memoria para siempre: ~15.000 objetos de ~3,6 KB por día, que son
// los ~55 MB/día que class30 venía creciendo desde el 20-sep.
//
// Se descarta lo MÁS VIEJO: lo que sale hacia el Python tiene que ser reciente,
// y con la cola sin tope lo que salía tenía semanas de atraso.

export function encolarAcotado(cola, item, max) {
  cola.push(item);
  let descartados = 0;
  while (cola.length > max) {
    cola.shift();
    descartados++;
  }
  return descartados;
}

export function topeDesdeEntorno(valor, porDefecto = 200) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : porDefecto;
}

// ¿Es una decisión interna de class25A? Ésas NO se reenvían al Python.
//
// El reenvío terminaba en `/miia/input`, que lo republica en `class25_ingest`
// como `type: "human_query"`, y class25B lo DESCARTA SIEMPRE con su filtro
// anti-loop (class25B.js, `esSeñalInterna`): todo texto de class25A lleva
// «puntos porcentuales estimados». O sea que el viaje entero —cola, POST, Redis,
// regex— era trabajo tirado, y de paso inflaba en ~40 por hora el contador de
// consultas del panel admin (`ws_manager.registrar_consulta()`).
//
// Se decide por canal y por tipo, no por regex sobre el texto: si mañana cambia
// la redacción de class25A, esto sigue cortando.
export function esDecisionInterna(channel, data) {
  if (channel === "class25a_output") return true;
  const tipo = String((data && (data.type || data.tipo)) || "").toLowerCase();
  return tipo === "decision_cuantitativa";
}
