/**
 * chat_router.js — router de intenciones del chat de MIIA.
 *
 * Vive aparte de class25B por el mismo motivo que `glosario.js` y
 * `llm_local.js`: importar class25B arrastra MySQL, Redis y el SDK de Google, así
 * que la lógica metida ahí adentro no se puede probar. Acá no hay nada que
 * importar: es una función pura de (texto, opciones) → intención.
 *
 * POR QUÉ EXISTE (el «punto 10» del reporte del 2-nov-2026)
 * --------------------------------------------------------
 * Las preguntas de opinión («¿qué opinás de US?», «¿ves algún patrón?») salían
 * del motor de lenguaje local (gemma2:2b) SIN un solo dato del sistema, y
 * cuando el motor no contestaba a tiempo caían a plantillas fijas («Soy MIIA, tu
 * asistente…», «Con eso no tengo un dato preciso…», «recomiendo reducir
 * exposición…»). Este router decide QUÉ se está preguntando y SOBRE QUÉ
 * instrumentos, para que la respuesta se arme con la evidencia que el sistema
 * tiene (chat_evidencia.js) y se redacte en lenguaje natural (chat_redactor.js).
 *
 * Tres cosas que hace y que antes no se hacían:
 *   • Entiende alias en castellano: «US», «tecnología», «Argentina», «Brasil»,
 *     «bancos», «oro»… → los ETFs del universo que los representan.
 *   • Hereda el tema: «¿y el riesgo?» o «¿por qué?» después de hablar de XLK
 *     sigue hablando de XLK, como haría una persona.
 *   • No confunde un saludo con un nombre: la versión vieja de `_detectarNombre`
 *     tomaba «Hola» como nombre propio y lo GUARDABA en `users.name`.
 */

// ── Normalización ─────────────────────────────────────────────────────────
export function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // sin tildes
    .toLowerCase()
    .replace(/[¿¡"“”«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _escapar(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tickers que también son palabras comunes en castellano: sólo cuentan si el
// usuario los escribió en MAYÚSCULAS ("buen dia" no es DIA; "el uso" no es USO).
const TICKER_PALABRA = new Set(["DIA", "USO", "JETS", "QUAL", "INDA", "ITB", "ARKK"]);

// ── Alias en castellano → instrumentos del universo ──────────────────────
// [regex sobre el texto NORMALIZADO, tickers, etiqueta para el redactor]
// El orden importa: lo específico antes que lo general ("bancos regionales"
// antes que "bancos", "consumo básico" antes que "consumo").
const ALIAS = [
  [/\b(s ?& ?p( ?500)?|sp ?500|standard (and|&) poor)/, ["SPY"], "el S&P 500"],
  [/\bnasdaq\b/, ["QQQ"], "el Nasdaq 100"],
  [/\bdow( jones)?\b/, ["DIA"], "el Dow Jones"],
  [/\b(small ?caps?|russell|empresas (chicas|pequenas))\b/, ["IWM"], "las small caps de EE.UU."],
  [/\b(ee\.? ?uu\.?|eeuu|estados unidos|usa|u\.s\.a?\.?|wall street|norteamerica\w*|americanas?|americanos?)\b|(^|[^a-z])us([^a-z]|$)/,
    ["SPY", "QQQ", "IWM", "DIA"], "Estados Unidos"],
  [/\b(semiconductor\w*|chips?)\b/, ["SMH"], "semiconductores"],
  [/\b(tecnolog\w*|tech|tecnologicas?)\b/, ["XLK", "SMH"], "tecnología"],
  [/\bbancos regionales\b/, ["KRE"], "los bancos regionales"],
  [/\b(financier\w*|bancos?|bancari\w*|finanzas)\b/, ["XLF", "KRE"], "el sector financiero"],
  [/\b(petroleras?|exploracion petrolera)\b/, ["XOP", "XLE"], "las petroleras"],
  [/\b(energ\w*|petroleo|crudo|oil)\b/, ["XLE", "XOP"], "energía"],
  [/\bbiotec\w*/, ["XBI"], "biotecnología"],
  [/\b(salud|farma\w*|healthcare|sanitari\w*)\b/, ["XLV", "XBI"], "salud"],
  [/\bconsumo (masivo|basico|basicos|defensivo|esencial)\b/, ["XLP"], "consumo básico"],
  [/\bconsumo discrecional\b/, ["XLY"], "consumo discrecional"],
  [/\bconsumo\b/, ["XLY", "XLP"], "consumo"],
  [/\b(retail|minoristas?|comercio minorista)\b/, ["XRT"], "retail"],
  [/\bindustria(s|l|les)?\b/, ["XLI"], "industria"],
  [/\bmateriales\b/, ["XLB"], "materiales"],
  [/\b(inmobiliari\w*|real estate|bienes raices|reits?)\b/, ["XLRE", "VNQ"], "inmobiliario"],
  [/\b(utilities|servicios publicos|electricas?|energia electrica)\b/, ["XLU"], "servicios públicos"],
  [/\b(comunicaciones?|telecom\w*)\b/, ["XLC"], "comunicaciones"],
  [/\b(constructoras?|viviendas|homebuilders?)\b/, ["ITB"], "las constructoras"],
  [/\b(aerolineas?|aviacion)\b/, ["JETS"], "aerolíneas"],
  [/\btransporte\b/, ["IYT"], "transporte"],
  [/\b(mineria|mineras?|metales)\b/, ["XME", "GDX"], "metales y minería"],
  [/\b(oro|mineras de oro|gold)\b/, ["GDX"], "las mineras de oro"],
  [/\b(innovacion|disruptiv\w*|cathie|ark)\b/, ["ARKK"], "innovación disruptiva"],
  [/\bmomentum\b/, ["MTUM"], "el factor momentum"],
  [/\b(factor calidad|quality)\b/, ["QUAL"], "el factor calidad"],
  [/\b(factor valor|value)\b/, ["VTV"], "el factor valor"],
  [/\b(factor crecimiento|growth)\b/, ["VUG", "IWF"], "el factor crecimiento"],
  [/\b(baja volatilidad|min(ima)? vol(atilidad)?)\b/, ["USMV"], "baja volatilidad"],
  [/\b(argentin\w*|merval|arg)\b/, ["ARGT"], "Argentina"],
  [/\b(brasil\w*|bovespa)\b/, ["EWZ"], "Brasil"],
  [/\bmexic\w*/, ["EWW"], "México"],
  [/\b(latinoam\w*|latam|america latina|sudamerica\w*)\b/, ["ILF", "EWZ", "EWW", "ARGT"], "Latinoamérica"],
  [/\b(china|chin[oa]s)\b/, ["FXI"], "China"],
  [/\b(japon\w*)\b/, ["EWJ"], "Japón"],
  [/\b(alemania|aleman\w*)\b/, ["EWG"], "Alemania"],
  [/\b(reino unido|inglaterra|britanic\w*|londres|uk)\b/, ["EWU"], "el Reino Unido"],
  [/\bsuiza\b/, ["EWL"], "Suiza"],
  [/\bcorea\w*/, ["EWY"], "Corea del Sur"],
  [/\btaiwan\w*/, ["EWT"], "Taiwán"],
  [/\bhong kong\b/, ["EWH"], "Hong Kong"],
  [/\baustralia\w*/, ["EWA"], "Australia"],
  [/\bindia\b/, ["INDA"], "India"],
  [/\bcanad\w*/, ["EWC"], "Canadá"],
  [/\b(europa|europe\w*)\b/, ["EWG", "EWU", "EWL"], "Europa"],
  [/\b(asia|asiatic\w*)\b/, ["EWJ", "EWY", "EWT", "EWH", "INDA", "FXI"], "Asia"],
  [/\bemergentes?\b/, ["EEM"], "los emergentes"],
  [/\b(desarrollados|mercados desarrollados)\b/, ["EFA"], "los desarrollados fuera de EE.UU."],
];

// Lo que el usuario puede nombrar y el sistema NO mide. Se contesta con
// honestidad (y, si existe, con lo más parecido que sí está en el universo).
const FUERA = [
  [/\b(bitcoin|btc|cripto\w*|crypto)\b/, "las criptomonedas (Bitcoin incluido)", []],
  [/\b(ethereum|eth)\b/, "Ethereum", []],
  [/\b(bonos?|treasur\w*|tlt|agg|renta fija)\b/, "los bonos", ["XLRE", "XLU"]],
  [/\b(plata|silver|slv)\b/, "la plata", ["XME"]],
  [/\bgld\b/, "el oro físico (GLD)", ["GDX"]],
  [/\b(dolar|blue|mep|ccl)\b/, "el dólar", []],
];
// Equivalentes: lo mismo con otro ticker. VOO, IVV y VTI replican el S&P/total
// de EE.UU.; el sistema mide SPY, que es la misma pregunta.
const EQUIVALENTE = { VOO: "SPY", IVV: "SPY", VTI: "SPY", USO: "XLE" };

// ── Patrones de intención (sobre el texto normalizado) ────────────────────
// El rendimiento de MIIA según el régimen de mercado (16-nov-2026).
const _REG = "(regimen|mercados? (alcistas?|bajistas?|laterales?)|cuando (el mercado )?(baja|sube|cae|esta (alcista|bajista|lateral))|en (las )?(bajas|subas|caidas))";
const _VERBO = "(gan\\w*|aciert\\w*|acert\\w*|rend\\w*|te va|te fue|mejor|peor)";
const REGIMEN_RENDIMIENTO = new RegExp(`${_REG}\\b.*\\b${_VERBO}|\\b${_VERBO}\\b.*\\b${_REG}`);

const P = {
  saludo:   /^(hola+|holis|holaa+|buenas|buen(os|as)? (dias?|tardes|noches)|buen dia|hey|hi|hello|saludos|que tal|como (estas|andas|va|te va|anda)|todo bien|que onda)\b/,
  gracias:  /^(muchas |mil )?(gracias|grax|thx|thanks|genial|perfecto|excelente|buenisimo|barbaro|copado|joya|de diez|re bien|muy bien|chevere|buenisima|espectacular|crack|groso|gracias miia)\b/,
  seguir:   /^(si+|sip|sii+|dale|ok|okay|okey|oka|claro|bueno|va|listo|de una|obvio|porfa|por favor|contame( mas)?|segui|sigue|mas|mas info|mas detalle|amplia(me)?|explicame mas|profundiza|y|e|y entonces|a ver|veamos|mostrame|si,? (dale|porfa|por favor|mostrame|contame))$/,
  negar:    /^(no+|nop|no gracias|nah|para nada|todavia no|despues|mas tarde)$/,
  // Al final, desde el 13-nov-2026: «¿cómo te percibís?, ¿eres consciente de ti
  // misma?», con las faltas reales («consiente», «conciente»), «¿tenés
  // sentimientos?», «¿estás viva?»: preguntas sobre MIIA que caían en la charla.
  identidad: /((opin\w*|pens\w*|parece|crees|decis) (de|sobre) (vos|ti|vos mism[oa]|ti mism[oa]|tu creador|tu creadora|martin|miia)\b|quien(es)? (te|lo|la) (creo|hizo|desarrollo|programo|entreno|fabrico|diseno|armo)|tu creador|quien es tu (creador|dueno|desarrollador)|(sos|eres) (de )?(google|openai|chat ?gpt|gemini|meta|microsoft)|(sos|eres) una? (ia|bot|robot|persona|humano|maquina|programa)|que modelo|que (ia|inteligencia artificial) (sos|eres|usas)|como (funcionas|trabajas|pensas|razonas|podes hablar|puedes hablar|hablas|sabes hablar|aprendes|decidis)|^(que|quien) (sos|eres)\b|de donde (sacas|salen|obtenes) (los datos|la info|los numeros)|que significa miia|que es miia|(sos|eres|estas) (auto)?(consciente|consiente|conciente)|(conscien|consien|concien)\w* de (ti|vos|si) mism[oa]|(tenes|tienes) (conciencia|consciencia|conciensia|sentimientos|emociones|alma|vida propia)|(sentis|sientes) (algo|emociones|cosas)|como te (percibis|percibes|sentis|sientes)|(sos|eres|estas) viva\b|(sos|eres) real\b|pensas por (vos|ti) mism[oa])/,
  capacidades: /(que (podes|puedes|sabes|sabe) (hacer|responder|contestar|decir|analizar|mostrar)|que te (puedo|podria) (preguntar|consultar)|para que (servis|sirves|sirve)|que (cosas|temas) (sabes|manejas|podes)|^ayuda$|como te (uso|usamos|consulto)|que haces\b|en que me (ayudas|podes ayudar))/,
  mercado_abierto: /((mercado|bolsa|nyse|wall street|rueda)\b.*\b(abiert|cerrad|abre|cierra|opera|funciona hoy))|\b(abre|cierra|abrio|cerro) (el|la) (mercado|bolsa|nyse)|hay rueda|hay mercado|hoy (hay|opera|abre) (el )?(mercado|bolsa|rueda)|es feriado|a que hora (abre|cierra)|^esta abierto|^(abrio|cerro)\b/,
  acierto:  /(tasa de acierto|aciert|asiert|precision|accuracy|efectividad|que tan (bueno|buena|preciso|precisa|confiable|bien) (sos|eres|es|funciona)|cuanto (acertas|le pegas|le embocas)|le pegas|track record|ventaja (real|estadistica)|\bedge\b|rank ?ic|sos (confiable|bueno)|funcionan tus (senales|predicciones)|como (se comporta|rinde|rindio|funciona|anda|va|le (fue|va)) (el |lo )?(tuyo|tu (sistema|backtesting|modelo|estrategia|senal|prediccion|motor))|tu (backtesting|rendimiento|desempeno|performance|track record)|como (te (fue|va)|venis|rendis|rindio el sistema)|(que|como) (resultados|rendimiento|desempeno) (da|tiene|tuvo|tenes|tuviste)|si (te equivocas|te equivoca|te equivocaste|acertas|aciertas|le pegas|fallas|fallaste)\b|\b(te equivocas|te equivocaste|fallas|le erras) (mucho|seguido|a menudo|poco|a veces|siempre|bastante|nunca)\b|cuanto (te equivocas|fallas|le erras)|(cada cuanto|cuantas veces|con que frecuencia) (te equivocas|fallas|le erras|acertas)|^(el tuyo|lo tuyo)$)/,
  portfolio: /(portafolio|portfolio|porfolio|portafolo|cartera|armame|armar (una|un|mi) |quiero invertir|dame (unos )?activos|como invierto|como deberia invertir|diversific)/,
  // «el portafolio que me armaste», «mi cartera», «¿cómo está mi porfolio?»:
  // pregunta por el que YA tiene, no pide uno nuevo (4-nov-2026).
  miPortfolio: /(\bmis? (portafolios?|portfolios?|porfolios?|carteras?|inversion(es)?)\b|\b(portafolio|portfolio|porfolio|cartera)s? (que (me|vos|tu) |que tengo|de antes|anterior|actual|recomendad[oa]|sugerid[oa]|guardad[oa])|(me|que me) (armaste|recomendaste|diste|sugeriste|pasaste|propusiste|armo|recomendo))/,
  portfolioRef: /\b(portafolios?|portfolios?|porfolios?|carteras?)\b.*\b(sirve|sirven|funciona|conviene|aguanta|esta bien|regimen|este mercado|el mercado|como (esta|va|viene|anda|rinde)|rinde|rindiendo|rendimiento|ajust\w*|cambi\w*|rebalance\w*|revis\w*|actualiz\w*|mantengo|sigue (sirviendo|bien))\b/,
  // «Borrá mi cartera», «olvidate de mi portafolio»: se borra, no se evalúa ni se arma otra (6-nov).
  borrarPort: /\b(borr\w*|elimin\w*|olvid\w*|descart\w*|quit\w*|tira(la|lo)?|resete\w*)\b/,
  portfolioNuevo: /\b(armame|armar|armalo|arma (un|una|otro|otra)|haceme|creame|dame|nuev[oa]|otr[oa]|quiero (un|una|invertir)|recomendame (un|una))\b/,
  ajustarPort: /(cambi\w*|ajust\w*|sac[oa]r?\b|agreg\w*|rebalance\w*|que (hago|harias|cambiarias|sacarias)|lo mantengo|mantener|lo dejo|vend\w*|conviene|deberia|sirve|y (el )?riesgo|por que)/,
  // 13-nov-2026: acepta el PLURAL («¿qué es un ETFs?», «¿qué son los ETFs?»:
  // `etf\b` no matcheaba «etfs» y la pregunta caía en la charla libre, que si el
  // motor no llegaba contestaba «no me salió una respuesta») y las formas «¿para
  // qué sirve un ETF?» / «¿cómo funciona un ETF?».
  concepto: /(que (es|son|significa|significan|quiere decir|quieren decir)|explicame|defin\w*|para que (sirve|sirven)|como (funciona|funcionan))( (un|una|el|la|los|las|lo))? (etf|rank ?ic|edge|volatilidad|drawdown|caida maxima|riesgo global|senal|buy|sell|hold|stop.?loss|horizonte|confianza|ranking|rsi|macd|sharpe|beta|alfa|alpha|diversificacion|benchmark|indice|small caps?|factor|momentum|amplitud|rotacion|sector defensivo|defensivos?|ciclicos?)(e?s)?\b/,
  // «¿Es mucho?», «¿eso es alto?», «¿es mucho en términos de mercado?» (13-nov):
  // pide la ESCALA del número que acaba de ver (el riesgo de la tarjeta, el de
  // la respuesta anterior). Sin esto no había intención y caía en la charla.
  magnitud: /^(y )?(eso |esto |ese (numero|valor|porcentaje|nivel) |el riesgo )?(es|son|esta) (mucho|muy (alto|bajo)|alto|poco|bajo|normal|bueno|malo|grave|preocupante|elevado|demasiado)\b/,
  comparar: /(\bvs\.?\b|versus|\bcontra\b|compar\w*|diferencia entre|\bmejor\b.*\b(o|que)\b|cual (de|entre)|\bentre\b.*\by\b|\bo\b)/,
  rankingMejor: /(que|cual|cuales|quienes|algo)\b.*\b(sube|suben|subiendo|mejor|mejores|fuerte|fuertes|gana|ganan|ganando|lider|lideran|destaca|destacan|recomend\w*|compr\w*|invertir hoy|oportunidad\w*|top)|^top\b|mas (sube|suben|fuerte)|\bganadores\b/,
  rankingPeor:  /(que|cual|cuales|quienes|algo)\b.*\b(baja|bajan|bajando|peor|peores|debil|debiles|pierde|pierden|perdiendo|castigad\w*|vend\w*|evitar|cae|caen|cayendo|flojo|flojos)|mas (baja|bajan|cae|caen|flojo)|\bperdedores\b/,
  rankingAmbos: /(ranking|las senales|tus senales|senales de hoy|que senales|que marca(s)? hoy|tabla)/,
  patron:   /(patron\w*|tendencias?|ves algo|que ves|algo raro|anomal\w*|correlacion\w*|rotacion|que esta pasando|que pasa (hoy|en el mercado|con el mercado)|movimiento\w* (raro|del dia)|notas algo|algun patron)/,
  porque:   /(por que|porque|porq|xq|razon|razones|motivo|explicame|explica|fundament\w*|justific\w*|que lo (empuja|mueve)|de donde sale)/,
  riesgo:   /(riesgo|riesgos|riesgos[ao]|volatil\w*|seguro|segura|peligro\w*|arriesgad\w*|cuanto (puedo|podria) perder|que tan riesgos)/,
  precio:   /(precio|cotiza\w*|cuanto (vale|cuesta|esta|sale|cotiza)|valor actual|a cuanto)/,
  noticias: /(noticia\w*|sentimiento|prensa|titular\w*|que dicen|que se dice|novedades (de|sobre)|headlines?)/,
  regimen:  /(regimen|fase del mercado|mercado (alcista|bajista|lateral)|es (alcista|bajista|lateral)|estamos en (un mercado|una fase)|ciclo del mercado)/,
  crisis:   /(crisis|crash|burbuja|recesion|colapso|2008|1929|corralito|desplome)/,
  senal:    /(senal|senales|\bbuy\b|\bsell\b|\bhold\b|que (dice|marca) (el sistema|miia)|comprar|vender|compro|vendo)/,
  opinion:  /(opin\w*|pens\w*|parece|como (lo |la )?ves|conviene|vale la pena|como (esta|viene|anda|va)|que onda|que tal (esta|viene|anda)|te gusta|lo ves)/,
  // Palabras de mercado: una opinión sin instrumento pero CON alguna de estas
  // es «¿cómo ves el mercado?» (resumen); sin ninguna es charla libre (5-nov):
  // «¿qué opinás de Messi?» contestaba con el resumen del mercado.
  mercadoPalabra: /\b(mercados?|bolsas?|accion\w*|invert\w*|inversion\w*|etfs?|sector\w*|wall street|dolar\w*|economia|tasas?|bonos?|indices?|merval|nasdaq|s&?p|cartera|portafolio|portfolio|precios?|cotiz\w*|activos?|rueda|momento)\b/,
  resumen:  /(como (esta|viene|anda|va|cerro|abrio) (el |la |hoy )?(mercado|bolsa|todo|dia|rueda)|^como (esta|viene|anda) (hoy|todo)|resumen|panorama|novedades|que hay de nuevo|como (cerro|abrio)|como viene el dia)/,
};

// Conceptos con definición propia en chat_redactor (clave canónica).
const CONCEPTOS = [
  [/\betfs?\b/, "etf"], [/volatilidad/, "volatilidad"], [/(drawdown|caida maxima)/, "drawdown"],
  [/riesgo global/, "riesgo_global"], [/stop.?loss/, "stop_loss"], [/horizonte/, "horizonte"],
  [/confianza/, "confianza"], [/ranking/, "ranking"], [/\brsi\b/, "rsi"], [/\bmacd\b/, "macd"],
  [/sharpe/, "sharpe"], [/\bbeta\b/, "beta"], [/\b(alfa|alpha)\b/, "alfa"],
  [/diversificacion/, "diversificacion"], [/(benchmark|indice)/, "benchmark"],
  [/amplitud/, "amplitud"], [/rotacion/, "rotacion"], [/(defensivo|ciclico)/, "defensivos"],
  [/rank ?ic/, "rank_ic"], [/\bedge\b/, "edge"], [/\b(buy|sell|hold|senal(es)?)\b/, "senal"], [/small caps?/, "small_caps"], [/(factor|momentum)/, "factor"],
];

// Temas sin instrumento propio, mapeados a lo que el universo SÍ mide y suele
// reaccionar. Es conocimiento general (lo dice el redactor así: «suele»), no un
// dato del sistema; el dato es cómo se movieron esos instrumentos.
const TEMAS = [
  [/\b(tasas?|fed|reserva federal|powell|bonos?|rendimientos? de los bonos|treasur\w*)\b/, "las tasas de interés", ["XLRE", "XLU", "KRE", "ITB"]],
  [/\b(inflacion|ipc|cpi)\b/, "la inflación", ["XLP", "XLE", "XLRE"]],
  [/\b(petroleo|crudo|opep|opec)\b/, "el petróleo", ["XLE", "XOP"]],
  [/\b(inteligencia artificial|nvidia|chatgpt|\bia\b)/, "la inteligencia artificial", ["SMH", "XLK", "QQQ"]],
  [/\b(guerra|geopolitic\w*|conflicto|tension\w*)\b/, "la geopolítica", ["XLE", "GDX", "JETS"]],
  [/\b(dolar|emergentes|tipo de cambio)\b/, "el dólar y los emergentes", ["EEM", "EWZ", "ARGT"]],
  [/\b(elecciones?|milei|gobierno argentino|riesgo pais)\b/, "la política argentina", ["ARGT"]],
  [/\b(recesion|desaceleracion|economia (de )?ee\.? ?uu)\b/, "el ciclo económico", ["XLY", "XLP", "IWM"]],
];

// Temas de charla que llevan un país o un sector como adjetivo («el fútbol
// argentino», «la música brasilera», «el vino chileno»): no son el mercado.
const FUERA_DEL_MERCADO = /\b(futbol\w*|mundial\w*|seleccion|messi|maradona|scaloni|copa|goles?|partidos?|equipos?|hinchas?|musica|cancion\w*|bandas?|rock|cumbia|tango|peliculas?|series|libros?|comidas?|asado|vinos?|empanadas?|mate|cocina|clima|turismo|viaj\w*|playas?|cultura|historia|idioma|gente|ciudad\w*|paisaje\w*|arte|deportes?|tenis|basquet|rugby|formula 1|literatura|escritor\w*|actor\w*|actriz|jugador\w*|campeon\w*|autos?|celular\w*|videojuego\w*|cantante\w*|artista\w*|recetas?|mascotas?|perros?|gatos?|pelis?)\b/;

// Intenciones con datos que "contame más" puede ampliar.
const AMPLIABLES = new Set(["opinion", "senal", "porque", "riesgo", "precio", "noticias",
                            "comparar", "ranking", "patron", "resumen", "regimen", "mi_portfolio"]);

const AMPLIAR = { opinion: "porque", senal: "porque", porque: "opinion", riesgo: "opinion",
                  precio: "opinion", noticias: "opinion", comparar: "opinion", ranking: "patron",
                  patron: "ranking", resumen: "patron", regimen: "patron", mi_portfolio: "mi_portfolio" };

// Palabras que, en un mensaje corto, indican que sigue la charla anterior.
const SIGUE_TEMA = /^(y |y\?|e |que tal |como |cual |por que|porque|xq)|\b(eso|ese|esa|esto|este|lo mismo|el mismo|la misma)\b/;

// ── «Sí» y «no» en cualquier forma (5-nov-2026) ──────────────────────────
// La regex de `P.seguir` sólo aceptaba frases exactas: «Si porfavor» (junto),
// «si claro», «ok dale», «dale porfa», «sí quiero», «por supuesto» o «sisi»
// caían en la charla libre, iban al motor de lenguaje y, si no llegaba a
// tiempo, la respuesta era «esa me la quiero pensar bien… repetímela». Ahora un
// mensaje corto hecho SÓLO de palabras de aceptación (y cortesía) es un «sí».
// Núcleo: alguna de estas tiene que estar para que sea una aceptación.
const SI_NUCLEO = new Set(["si", "sii", "siii", "sip", "sis", "sisi", "sisisi", "dale", "dalee", "daale",
  "ok", "okay", "okey", "oka", "oki", "okis", "claro", "clarisimo", "obvio", "obvi", "seguro", "adelante",
  "listo", "quiero", "interesa", "interesaria", "mostrame", "muestrame", "mostralo", "contame", "cuentame",
  "decime", "dime", "hacelo", "hazlo", "mandale", "metele", "porfa", "porfavor", "porfis", "xfa", "xfavor",
  "plis", "pliss", "please", "pls", "supuesto", "yes", "yep", "exacto", "afirmativo", "bueno", "va", "vamos",
  "veamos", "segui", "sigue", "continua", "continuar", "sigamos", "amplia", "ampliame", "genial", "perfecto",
  "buenisimo", "barbaro", "joya", "copado", "venga"]);
// Relleno que puede acompañar al «sí» sin cambiarlo.
const SI_RELLENO = new Set(["por", "favor", "gracias", "muchas", "miia", "che", "entonces", "eso", "esa", "ese",
  "lo", "la", "me", "te", "de", "una", "uno", "y", "ya", "mas", "un", "poco", "a", "ver", "que", "si",
  "bien", "mismo", "nomas", "ahora", "vos", "el"]);
const NO_NUCLEO = new Set(["no", "nop", "noo", "nooo", "nah", "paso", "dejalo", "deja", "nones", "negativo"]);

/**
 * ¿El mensaje es sólo un «sí» (con cortesía)? Devuelve {gracias} o null.
 * «Si porfavor» → sí; «sí, XLK» → null (trae algo más); «no, gracias» → null.
 */
export function esAfirmacion(t) {
  const tok = normalizar(t).replace(/[^a-z0-9ñ ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!tok.length || tok.length > 7) return null;
  if (tok.some(w => NO_NUCLEO.has(w))) return null;
  if (!tok.some(w => SI_NUCLEO.has(w))) {
    // «por favor» / «de una» / «por supuesto» solos también son un sí.
    const s = tok.join(" ");
    if (!/^(por favor|de una|por supuesto|me interesa|eso mismo|eso quiero)$/.test(s)) return null;
  }
  if (!tok.every(w => SI_NUCLEO.has(w) || SI_RELLENO.has(w))) return null;
  // «Genial», «perfecto», «bárbaro» solos (sin un sí al lado) son un gracias.
  const soloElogio = tok.every(w => ["genial", "perfecto", "buenisimo", "barbaro", "joya", "copado", "gracias",
                                      "muchas", "miia", "che"].includes(w));
  if (soloElogio) return null;
  return { gracias: tok.includes("gracias") };
}

/** ¿El mensaje es sólo un «no» (con cortesía)? «no porfavor», «no, está bien». */
export function esNegacion(t) {
  const tok = normalizar(t).replace(/[^a-z0-9ñ ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!tok.length || tok.length > 6 || !tok.some(w => NO_NUCLEO.has(w))) return false;
  const OK = new Set([...NO_NUCLEO, "gracias", "por", "favor", "porfavor", "porfa", "miia", "che", "ahora",
                      "todavia", "despues", "mas", "tarde", "igual", "esta", "bien", "asi", "nada", "lo"]);
  return tok.every(w => OK.has(w));
}

// ── Entidades ─────────────────────────────────────────────────────────────
/**
 * Tickers y grupos mencionados.
 * @param {string} original  texto tal cual (para respetar MAYÚSCULAS)
 * @param {string} t         texto normalizado
 * @param {string[]} universo  tickers que el sistema mide
 * @param {string[]} reconocidos  tickers que se reconocen pero NO se miden
 */
export function entidades(original, t, universo = [], reconocidos = []) {
  const up = String(original || "").toUpperCase();
  const tickers = [];
  const uni = new Set(universo.map(x => String(x).toUpperCase()));
  for (const tk of uni) {
    const re = new RegExp(`(?<![A-Z0-9])${_escapar(tk)}(?![A-Z0-9])`);
    const enMayus = re.test(String(original || ""));
    if (enMayus || (!TICKER_PALABRA.has(tk) && re.test(up))) tickers.push(tk);
  }
  // Equivalentes (VOO → SPY) y no medidos.
  const fuera = [];
  for (const tk of reconocidos.map(x => String(x).toUpperCase())) {
    if (uni.has(tk)) continue;
    const re = new RegExp(`(?<![A-Z0-9])${_escapar(tk)}(?![A-Z0-9])`);
    const hit = re.test(String(original || "")) || (!TICKER_PALABRA.has(tk) && tk !== "USO" && re.test(up));
    if (!hit) continue;
    if (EQUIVALENTE[tk] && uni.has(EQUIVALENTE[tk])) {
      if (!tickers.includes(EQUIVALENTE[tk])) tickers.push(EQUIVALENTE[tk]);
    } else {
      fuera.push({ nombre: tk, proxy: [] });
    }
  }
  const grupos = [];
  for (const [re, tks, etiqueta] of ALIAS) {
    if (re.test(t)) {
      const validos = tks.filter(x => uni.has(x));
      if (validos.length && !grupos.some(g => g.etiqueta === etiqueta)) grupos.push({ etiqueta, tickers: validos });
    }
  }
  // "Bancos regionales" no debe sumar además "el sector financiero" entero.
  _depurarGrupos(grupos);
  for (const [re, nombre, proxy] of FUERA) {
    if (re.test(t) && !fuera.some(f => f.nombre === nombre))
      fuera.push({ nombre, proxy: proxy.filter(x => uni.has(x)) });
  }
  let tema = null;
  for (const [re, nombre, tks] of TEMAS) {
    if (re.test(t)) { tema = { nombre, tickers: tks.filter(x => uni.has(x)) }; break; }
  }
  return { tickers, grupos, fuera, tema };
}

function _depurarGrupos(grupos) {
  const especificos = [
    ["los bancos regionales", "el sector financiero"],
    ["consumo básico", "consumo"], ["consumo discrecional", "consumo"],
    ["semiconductores", "tecnología"], ["las petroleras", "energía"],
    ["las mineras de oro", "metales y minería"], ["biotecnología", "salud"],
    ["el S&P 500", "Estados Unidos"], ["el Nasdaq 100", "Estados Unidos"],
    ["el Dow Jones", "Estados Unidos"], ["las small caps de EE.UU.", "Estados Unidos"],
  ];
  for (const [esp, gen] of especificos) {
    if (grupos.some(g => g.etiqueta === esp)) {
      const i = grupos.findIndex(g => g.etiqueta === gen);
      if (i >= 0) grupos.splice(i, 1);
    }
  }
}

// ── Nombre propio (reemplaza al `_detectarNombre` viejo) ──────────────────
const NO_ES_NOMBRE = new Set([
  "hola", "gracias", "dale", "perfecto", "genial", "buenas", "bueno", "listo", "claro",
  "nuevo", "nueva", "principiante", "inversor", "inversora", "conservador", "conservadora",
  "moderado", "moderada", "agresivo", "agresiva", "argentino", "argentina", "de", "del",
  "un", "una", "el", "la", "muy", "bastante", "medio", "trader", "estudiante", "miia",
  "usuario", "cliente", "yo", "tu", "admin", "humano", "persona", "programador",
]);
export function detectarNombre(texto) {
  const s = String(texto || "").trim();
  // Explícito: "me llamo X", "mi nombre es X", "llamame X" (mayúscula o no).
  let m = s.match(/(?:^|[\s,.!¡¿])(?:me llamo|mi nombre es|ll[aá]mame|llamame|decime)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]{3,20})(?:\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,20}))?/i);
  // "soy X" sólo si X viene con mayúscula inicial (es un nombre, no un adjetivo).
  if (!m) m = s.match(/(?:^|[\s,.!¡¿])[Ss]oy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,20})(?:\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,20}))?(?=$|[\s,.!?])/);
  if (!m) return null;
  const nom = m[1];
  if (NO_ES_NOMBRE.has(normalizar(nom))) return null;
  const ape = m[2] && !NO_ES_NOMBRE.has(normalizar(m[2])) ? ` ${m[2]}` : "";
  return (nom.charAt(0).toUpperCase() + nom.slice(1).toLowerCase()) + ape;
}

// ── Clasificador ──────────────────────────────────────────────────────────
/**
 * @param {string} texto
 * @param {object} op
 *   universo     tickers medidos            (de universo.js)
 *   reconocidos  tickers sólo reconocidos   (BTC, GLD…)
 *   previo       {intencion, tickers, grupo} lo último que se habló en la sesión
 *   oferta       {intencion, tickers, grupo} lo último que MIIA ofreció ("¿querés que…?")
 *   ultima       "charla" si la última respuesta la escribió el motor de lenguaje
 * @returns {{intencion, tickers, grupo, fuera, tema, direccion, concepto,
 *            heredado, subtipo, texto: string}}
 */
export function clasificar(texto, op = {}) {
  const original = String(texto || "").trim();
  let t = normalizar(original).replace(/[?!.,;:]+$/g, "").trim();
  // «¿Cómo te va cuando el mercado baja?»: se mira ANTES de sacar el saludo,
  // porque «cómo te va» es justamente la pregunta (16-nov-2026).
  const pideRegimen = REGIMEN_RENDIMIENTO.test(t) && !/\b(portafolio|portfolio|porfolio|cartera)\b/.test(t);
  const universo = op.universo || [];
  const reconocidos = op.reconocidos || [];
  const previo = op.previo || null;
  const oferta = op.oferta || null;

  const base = { intencion: "libre", tickers: [], grupo: null, fuera: [], tema: null,
                 direccion: null, concepto: null, heredado: false, subtipo: null, texto: original };
  if (!t) return base;

  // Saludo pegado a una pregunta ("hola, ¿qué opinás de XLK?"): se saca el
  // saludo y se clasifica el resto. Si no queda nada, es un saludo.
  let saludo = false;
  const mSal = t.match(P.saludo);
  if (mSal) {
    saludo = true;
    const resto = t.slice(mSal[0].length).replace(/^[\s,.!-]+/, "").replace(/^miia\b[\s,.!-]*/, "").trim();
    if (!resto || /^(miia|como (estas|andas|va|te va)|todo bien|que tal)$/.test(resto)) {
      return { ...base, intencion: "saludo" };
    }
    t = resto;
  }
  const palabras = t.split(/\s+/).filter(Boolean).length;

  // «Sí» en cualquier forma («Si porfavor», «ok dale», «sí, claro»…). Va antes
  // que «gracias» para que «perfecto, dale» acepte la propuesta en vez de
  // contestar «¡de nada!».
  const afirma = esAfirmacion(t) || (P.seguir.test(t) ? { gracias: false } : null);
  // La última respuesta la dio el motor de lenguaje (charla libre): un «sí»
  // contesta a lo que ESE mensaje propuso, que sólo el motor conoce (lo ve en
  // el historial). Ampliar un tema de datos viejo sería contestar otra cosa.
  const charlaPrevia = op.ultima === "charla";
  if (afirma) {
    // Sin propuesta pendiente, "dale"/"contame más" amplía el último tema CON
    // DATOS; ampliar un saludo o la presentación no tiene sentido.
    // Ampliar = dar información NUEVA, no repetir: después de una opinión va
    // el porqué; después del ranking, los patrones; y así.
    const ampliable = !charlaPrevia && previo && AMPLIABLES.has(previo.intencion)
      ? { ...previo, intencion: AMPLIAR[previo.intencion] || previo.intencion, detalle: 2 } : null;
    const destino = oferta || ampliable;
    if (destino) return { ...base, intencion: "seguir", subtipo: oferta ? "oferta" : "ampliar", destino: { ...destino } };
    if (charlaPrevia) return { ...base, intencion: "libre", subtipo: "sigue_charla" };
    // «Sí, gracias» sin nada pendiente es un agradecimiento.
    if (afirma.gracias) return { ...base, intencion: "gracias" };
    return { ...base, intencion: "seguir", subtipo: "sin_tema" };
  }
  if (P.gracias.test(t) && palabras <= 6) return { ...base, intencion: "gracias" };
  if (P.negar.test(t) || esNegacion(t)) return { ...base, intencion: "negar" };

  // "Soy Martín" / "me llamo Ana": una presentación, no una pregunta.
  const nombre = detectarNombre(original);
  if (nombre && palabras <= 6 && !/\?/.test(original)) return { ...base, intencion: "presentacion", nombre, saludo };

  const ent = entidades(original, t, universo, reconocidos);
  // «¿Qué pensás del fútbol argentino?» no es una pregunta por ARGT (5-nov):
  // el país es un adjetivo de algo que no es el mercado. Sin un ticker escrito
  // y sin ninguna palabra de mercado, los alias de país/sector no cuentan y la
  // pregunta queda para la charla libre.
  if (!ent.tickers.length && ent.grupos.length && FUERA_DEL_MERCADO.test(t) && !P.mercadoPalabra.test(t)) {
    ent.grupos = [];
  }
  const res = (intencion, extra = {}) => ({
    ...base, intencion, tickers: ent.tickers.slice(), grupo: ent.grupos[0] || null,
    grupos: ent.grupos, fuera: ent.fuera, tema: ent.tema, saludo, ...extra,
  });

  // «Dame el detalle (en ese orden)» después del resumen de noticias: se amplían
  // las noticias, no es charla libre (5-nov-2026).
  if (previo?.intencion === "noticias" && !ent.tickers.length && !ent.grupos.length && palabras <= 8
      && /(detalle|cada uno|uno por uno|ese orden|en orden|todos|cuales son|mas info)/.test(t)) {
    return res("noticias", { detalle: 2, heredado: true });
  }
  if (P.identidad.test(t))      return res("identidad", { subtipo: _subIdentidad(t) });
  // «¿Para qué sirve un ETF?» es una definición, no «¿para qué servís vos?»: va
  // antes que capacidades (13-nov-2026). Sólo si nombra un concepto del glosario.
  if (!ent.tickers.length && /^(para que (sirve|sirven)|como (funciona|funcionan))\b/.test(t) && P.concepto.test(t)) {
    const c = CONCEPTOS.find(([re]) => re.test(t));
    if (c) return res("concepto", { concepto: c[1] });
  }
  if (P.capacidades.test(t))    return res("capacidades");
  if (P.mercado_abierto.test(t)) return res("mercado_abierto");
  // «¿Qué es el rank IC / el edge?» pide la definición, no el número (6-nov).
  if (/^(que (es|son|significa|quiere decir)|explicame|defin\w*)\b.*\b(rank ?ic|edge)\b/.test(t)) {
    return res("concepto", { concepto: /edge/.test(t) && !/rank ?ic/.test(t) ? "edge" : "rank_ic" });
  }
  // «¿En qué régimen le ganás al mercado?», «¿cómo te va cuando el mercado baja?»
  // (16-nov-2026): el rendimiento POR RÉGIMEN, con su margen.
  if (!ent.tickers.length && pideRegimen) return res("acierto", { subtipo: "regimen" });
  if (P.acierto.test(t) && !ent.tickers.length) return res("acierto");
  // Su portafolio (el que ya tiene) va ANTES que «armame uno»: el 4-nov
  // «¿el portafolio que me armaste sirve para este régimen?» caía acá y
  // contestaba «¿cuál es tu tolerancia al riesgo?».
  if (!P.portfolioNuevo.test(t) && (P.miPortfolio.test(t) || P.portfolioRef.test(t))) {
    return res("mi_portfolio", {
      subtipo: P.borrarPort.test(t) ? "borrar"
             : /(cambi|ajust|rebalance|sac[oa]r?\b|agreg|lo mantengo|que hago)/.test(t) ? "ajustar" : null });
  }
  // Seguir hablando de SU portafolio: «¿y lo cambio?», «¿qué sacarías?».
  if (previo?.intencion === "mi_portfolio" && palabras <= 8 && !ent.tickers.length && !ent.grupos.length
      && P.ajustarPort.test(t)) {
    return res("mi_portfolio", { subtipo: "ajustar", heredado: true });
  }
  if (P.portfolio.test(t) && !ent.tickers.length && !ent.grupos.length) return res("portfolio");

  const hayEnt = ent.tickers.length > 0 || ent.grupos.length > 0;
  if (!hayEnt && ent.fuera.length) return res("fuera_universo");
  // «¿Quién creés que gana el próximo Mundial?», «¿cuál es el mejor asado?»
  // (7-nov-2026): son charla, no un ranking — «gana» y «mejor» disparaban
  // rankingMejor y MIIA contestaba con ETFs. Sin instrumento y sin palabra de
  // mercado, un tema de fuera del mercado va directo a la charla libre.
  if (!hayEnt && FUERA_DEL_MERCADO.test(t) && !P.mercadoPalabra.test(t)) return res("libre");

  // «¿Es mucho?» / «¿eso es alto?» / «¿es mucho en términos de mercado?»
  // (13-nov-2026): pregunta por la escala del número que acaba de ver. Si lo
  // anterior fue un tema con datos, se contesta ese tema; si no, el único número
  // con escala que la pantalla muestra siempre es el riesgo global (la tarjeta
  // «Riesgo 78%»), así que se explica ése. Antes no tenía intención → charla.
  if (!ent.tickers.length && palabras <= 10 && P.magnitud.test(t)) {
    const conDatos = previo && AMPLIABLES.has(previo.intencion) && previo.intencion !== "mi_portfolio"
      && (previo.tickers?.length || previo.grupo || ["riesgo", "resumen", "regimen", "ranking", "patron"].includes(previo.intencion));
    if (conDatos && !ent.grupos.length) {
      return { ...res(previo.intencion), tickers: (previo.tickers || []).slice(), grupo: previo.grupo || null,
               heredado: true, subtipo: "magnitud" };
    }
    return res("riesgo", { subtipo: "magnitud" });
  }

  if (!ent.tickers.length && P.concepto.test(t)) {
    const c = CONCEPTOS.find(([re]) => re.test(t));
    if (c) return res("concepto", { concepto: c[1] });
  }

  // Comparar: dos menciones distintas (dos tickers, dos grupos o uno de cada).
  const menciones = ent.tickers.length + ent.grupos.length;
  if (menciones >= 2 && P.comparar.test(t)) return res("comparar");

  // "¿Por qué cae el mercado?" es un PORQUÉ, no un "¿qué está cayendo?", y
  // "¿qué pasa que cae todo?" es un PATRÓN: van antes que el ranking.
  const empiezaPorque = /^(por que|porque|porq|xq)\b/.test(t);
  if (P.patron.test(t) && !ent.tickers.length) return res("patron");

  // Ranking: sin ticker puntual. Un grupo funciona como filtro ("¿qué de
  // Latinoamérica está más fuerte?").
  if (!ent.tickers.length && !empiezaPorque) {
    const mejor = P.rankingMejor.test(t), peor = P.rankingPeor.test(t);
    if (mejor && !peor) return res("ranking", { direccion: "mejor" });
    if (peor && !mejor) return res("ranking", { direccion: "peor" });
    if ((mejor && peor) || P.rankingAmbos.test(t)) return res("ranking", { direccion: "ambos" });
  }

  let intencion = null;
  if (P.patron.test(t))        intencion = "patron";
  else if (P.porque.test(t))   intencion = "porque";
  else if (P.riesgo.test(t))   intencion = "riesgo";
  else if (P.precio.test(t))   intencion = "precio";
  else if (P.noticias.test(t)) intencion = "noticias";
  else if (P.regimen.test(t))  intencion = "regimen";
  else if (P.crisis.test(t))   intencion = "crisis";
  else if (hayEnt && P.senal.test(t)) intencion = "senal";
  else if (!hayEnt && P.resumen.test(t)) intencion = "resumen";
  else if (P.opinion.test(t) || hayEnt) intencion = hayEnt ? "opinion"
    : (P.opinion.test(t) && (P.mercadoPalabra.test(t) || palabras <= 3) ? "resumen" : null);
  let subtipo = null;
  if (ent.tickers.length && /^(que es|que son|que significa)\b/.test(t)) {
    intencion = "opinion"; subtipo = "que_es";
  }
  // "¿Conviene invertir ahora?" / "¿es buen momento?" sin instrumento: no se
  // contesta sí o no (no es asesoramiento), se muestra lo que el sistema ve.
  if (!hayEnt && /(conviene|buen momento|mal momento|deberia (entrar|invertir|salir)|es momento de)/.test(t)) {
    intencion = "resumen"; subtipo = "conviene";
  }

  // ── Herencia del tema ────────────────────────────────────────────────
  // "¿y el riesgo?" / "¿por qué?" / "¿y XLF?" — lo que haría una persona.
  const corto = palabras <= 8;
  if (previo && corto) {
    const sigue = SIGUE_TEMA.test(t) || palabras <= 4;
    // "¿y comparado con QQQ?" → compara lo nuevo con lo anterior.
    if (menciones === 1 && /compar|contra|vs|versus|frente a/.test(t) && previo.tickers?.length) {
      const tks = [...new Set([...(previo.tickers || []), ...ent.tickers])];
      return { ...res("comparar"), tickers: tks, heredado: true };
    }
    if (!hayEnt && sigue && ["porque", "riesgo", "precio", "noticias", "senal", "opinion"].includes(intencion)
        && (previo.tickers?.length || previo.grupo)) {
      return { ...res(intencion), tickers: (previo.tickers || []).slice(),
               grupo: previo.grupo || null, heredado: true };
    }
    // "¿y XLF?" sin palabra de intención → la misma pregunta que antes.
    if (hayEnt && !intencion?.match(/patron|porque|riesgo|precio|noticias|regimen|crisis|senal/)
        && /^(y |e |y$|que tal |como (esta|viene|anda) )/.test(t) && previo.intencion
        && !["saludo", "gracias", "seguir", "negar", "libre", "capacidades", "identidad"].includes(previo.intencion)) {
      const intPrev = previo.intencion === "comparar" ? "opinion" : previo.intencion;
      return { ...res(intPrev), heredado: true };
    }
  }

  if (intencion) return res(intencion, subtipo ? { subtipo } : {});
  if (ent.tema) return res("libre", { subtipo: "tema" });
  return res("libre");
}

function _subIdentidad(t) {
  // «¿Sos consciente de vos misma?», «¿cómo te percibís?», «¿tenés sentimientos?»
  // (13-nov-2026): la contesta el motor (charla) y, si no llega, un respaldo que
  // CONTESTA la pregunta —antes caía en la charla libre y salía «no me salió una
  // respuesta» con números del mercado que nadie había pedido—.
  if (/(conscien|consien|concien|sentimientos|emociones|\balma\b|vida propia|(sentis|sientes) (algo|emociones|cosas)|como te (percibis|percibes|sentis|sientes)|viva\b|(sos|eres) real\b|pensas por (vos|ti) mism)/.test(t)) return "conciencia";
  // «¿Qué opinás de vos misma / de tu creador?»: una opinión, no la ficha técnica.
  if (/(opin\w*|pens\w*|parece|crees|decis|te (gusta|cae|sentis)|como te (sentis|ves)|que tal (es )?(tu creador|martin))/.test(t)) return "opina";
  if (/(como (podes|puedes|sabes) hablar|como hablas|que modelo|motor de lenguaje|como funcionas|como (pensas|razonas|aprendes|decidis))/.test(t)) return "como_funciona";
  if (/(de donde (sacas|salen|obtenes))/.test(t)) return "datos";
  if (/(sos|eres) (de )?(google|openai|chat ?gpt|gemini|meta|microsoft)/.test(t)) return "proveedor";
  if (/(que significa miia|que es miia)/.test(t)) return "nombre";
  return "quien";
}

// Expuesto para las pruebas.
export const _test = { ALIAS, FUERA, TEMAS, P };
