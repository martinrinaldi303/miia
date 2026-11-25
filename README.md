# MIIA — The Invisible Hand
### AI-assisted market intelligence | Open-source project

**MIIA** is a modular financial-market analysis platform designed to collect and process market information, combine quantitative and text-based signals, evaluate model outputs, and present analytical context to users.

- **Repository:** https://github.com/martinrinaldi303/miia
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Project website:** https://miiaia.com
- **Copyright:** © 2025-2026 Martín Francisco Rinaldi Toledo · DNDA registration (unpublished work — software), file **EX-2025-127876650- -APN-DNDA#MJ** · see [`NOTICE.md`](NOTICE.md)
- **Documentation license:** CC BY-NC 4.0 ([`docs/LICENSE-docs-CC-BY-NC-4.0.txt`](docs/LICENSE-docs-CC-BY-NC-4.0.txt))
- **Installation guide (Spanish):** [`docs/INSTALACION.md`](docs/INSTALACION.md) — Ubuntu server and Windows, with placeholders instead of real infrastructure
- **Full documentation:** [`docs/mapa del proyecto/`](docs/mapa%20del%20proyecto/) — `MIIA_Project_EN` (English) and `Proyecto MIIA` (Spanish), Word and PDF
- **Status:** Research and development. Predictive performance is not established as a reliable trading edge.

---

# English

## Overview

MIIA (Mano Invisible / The Invisible Hand) is an experimental, modular market-intelligence system. Its purpose is to turn heterogeneous market information into structured analytical signals and decision-support context.

The platform combines market-data ingestion, feature processing, quantitative models, text and sentiment analysis, portfolio-oriented analytics, backtesting, feedback collection, and a user-facing interface.

MIIA is a research and engineering project. It is **not** a broker, exchange, custodian, or registered investment adviser. Its outputs are informational and must not be treated as personalized investment advice or guarantees of future performance.

## Main capabilities

- **Market-data processing:** ingest and normalize price and market information from external data sources.
- **Quantitative analysis:** calculate technical and statistical features used by downstream analytical components.
- **Text and sentiment analysis:** process financial news and related text to derive contextual signals.
- **Model ensemble:** combine outputs from multiple analytical components through a coordination layer.
- **Portfolio analytics:** generate portfolio-oriented views using instrument data and configurable risk context.
- **Backtesting and evaluation:** compare model outputs with historical outcomes and baseline approaches.
- **Feedback and monitoring:** persist decisions, evaluate outcomes over time, and monitor component health.
- **User interface and APIs:** expose selected analytics and system information through application endpoints and dashboards.

## High-level architecture

MIIA follows a modular, multi-language architecture:

```text
External market and news data
            |
            v
   Data ingestion layer
            |
            v
Normalization and feature processing
            |
            v
Quantitative and text-analysis modules
            |
            v
   Coordination / decision layer
            |
       +----+-----+
       |          |
       v          v
Persistent data  Feedback and
   storage       evaluation
       |          |
       +----+-----+
            |
            v
       APIs and UI
```

The system uses a message-oriented communication pattern to reduce direct coupling between components. Redis is used for inter-process messaging and transient coordination; a relational database is used for persistent application and analytical data.

## Technology

The documented implementation uses a polyglot stack that includes:

- **JavaScript / Node.js** — orchestration, APIs, and application services.
- **Python** — data processing, analytical workflows, and selected model components.
- **C++** — performance-oriented computational components.
- **C# / .NET** — selected services and integration components.
- **Redis** — messaging and transient coordination.
- **MySQL-compatible relational storage** — persistent application and analytical records.

Exact runtime versions, host configuration, ports, filesystem paths, credentials, deployment addresses, and operational runbooks are intentionally not published in this README.

## Research and evaluation

MIIA includes offline model comparisons and a live outcome-verification workflow. The project documentation distinguishes between:

1. **Offline experiments**, which evaluate model families on historical data.
2. **Live observations**, which evaluate actual system outputs after their outcome horizon has elapsed.
3. **Baseline-relative edge**, which compares directional accuracy against a simple market-direction baseline.

These are not interchangeable. An offline result does not establish that the production system has the same performance.

**Latest live reading — 20 November 2026, 20:30 CET (NYSE open), 103 days of measurement, 50 instruments:**

| Metric | Value |
|---|---|
| Effective sample (independent 48 h windows × instrument) | 895 |
| Verified decisions | 115,799 |
| Baseline rate | 53.5 % |
| Directional accuracy | 55.0 % |
| Edge vs. baseline | **+1.5 pp** |
| Minimum detectable edge (noise band) | ±3.3 pp |
| Edge statistically significant | **No** |
| Rank IC (Spearman per session, 28 windows) | +0.041 (minimum detectable 0.114) — not significant |

The edge is positive but **inside the noise band**: the correct reading is *no demonstrable advantage*. A market-neutral version of the rank IC (+0.129, minimum detectable 0.110) crosses its band, but it is an auxiliary diagnostic, it was one of several comparisons, and 28 windows are few; it must not be read as evidence of a reliable edge until it holds with more data. This is not evidence of a profitable trading strategy.

**Reproducibility.** The full system can be rebuilt from zero with the scripts in this repository: `scripts/deploy_linux.sh` (Ubuntu server) or `scripts/deploy_windows.ps1` (Windows), following `docs/INSTALACION.md`. A new installation measures with its own live data from its first day, so its numbers will differ from these; the method (metrics, reading order and noise bands) is the same.

MIIA's evaluation remains ongoing. Any public performance claim should include the evaluation date, sample definition, benchmark, costs, uncertainty interval, and whether the result is offline or live.

## ORDEN 7 for the ETF system (25 November 2026)

After ORDEN 6, a series of offline simulations (sim43–sim56) asked what MIIA could
actually predict. The answer was narrow: across five years of data and several asset
classes, MIIA does **not** predict which ETF will beat the average over the next
two days better than chance. What *is* predictable is **how much** each asset will
move (volatility clusters), not **in which direction**. ORDEN 7 for the ETF system
applies only what that evidence supports, without interrupting the live measurement.

**Group A — deployed: two-day volatility forecast**

| Where | What changes |
|---|---|
| `MIIA/miia_chatbot.py` | For each ETF, an EWMA volatility forecast (RiskMetrics, λ = 0.94) for the next two days, and the ratio against its usual volatility. Sent inside `/api/portfolio` as `volatilidad_2d` and in each asset (`vol_2d_pct`, `ratio_vol`, `mas_movido`). |
| `scripts/chat_*.js`, `scripts/class25B.js` | The chat's risk answer adds "typical move of ±X % over the next two days, more/less than usual — this says how much, not which way". |
| `scripts/publi_src/index.html` | A "Next 2 days" box in the Portfolio panel: the ETFs expected to move more and less than usual. |

Why EWMA and not MIIA's neural chain: in `docs/simulaciones/sim56_volatilidad.py`
(50 ETFs, 5 years) the rank IC of "who will move more than usual" was **+0.138**
for EWMA, +0.123 for HAR and +0.115 for MIIA's chain, all far above a placebo
(+0.041). A one-line formula is as good as or better than the networks, so the
formula is what ships. It is **informational only**: it does not enter any
BUY/SELL decision or the thesis metrics.

It is deployed without restarting the orchestrator or the decision module
(the Python service is relaunched by its supervisor and the chat module respawns
automatically), so the live measurement series is not cut.

**Group B — measured and rejected**

Adding 1-, 5- and 22-day volatility to the market vector of `class10` was tested
in `docs/simulaciones/sim59_vector_volatilidad.py` before touching production:

| Question | 22 dims (current) | 25 dims (+ volatility) | Paired difference |
|---|---|---|---|
| Direction, 2 days (what MIIA decides) | −0.006 | −0.012 | −0.005 ± 0.016 |
| Volatility, 2 days | +0.115 | +0.121 | +0.005 ± 0.007 |

Neither difference is distinguishable from zero. Changing the vector would reset
the networks and cut the thesis series for no measurable gain, so it is **not**
applied. Risk-weighted portfolios were also left out: they require a full
restart and would break the portfolio control used by the experiment.

---

## Security and public-repository boundaries

This repository is intended to expose reusable source code and high-level technical documentation—not production access.

The public project must never contain:

- Passwords, API keys, access tokens, JWT secrets, OAuth client secrets, or payment credentials.
- SSH private keys, certificates, private configuration files, or `.env` files.
- Production IP addresses, internal hostnames, private network details, or exposed service ports.
- Database dumps, backups, user records, logs, model state, or private datasets.
- Admin account identifiers or operational incident details that reveal attack paths.
- Production deployment scripts unless they have been reviewed and made environment-agnostic.

Use placeholders in examples. Keep production configuration in a separate secret manager or protected environment. If a credential has ever been committed, revoke or rotate it; deleting it from the latest version is not sufficient. Review the complete Git history before publishing.

## Reproducibility

This README intentionally does not provide production deployment commands or real infrastructure settings. A reproducible public setup should be documented separately using:

- A local-only example configuration with placeholder values.
- Synthetic or properly licensed sample data.
- A development database and local message broker.
- Explicit dependency and build instructions.
- Automated tests that do not call production services or consume production API quotas.

## Contributing

Contributions are welcome through issues and pull requests. Before submitting:

1. Do not include secrets, personal data, production logs, or proprietary datasets.
2. Add or update tests for behavioral changes.
3. Document assumptions and known limitations.
4. Avoid claims of predictive performance unless supported by reproducible evaluation.

## License

MIIA is distributed under the **GNU Affero General Public License v3.0**. See [`LICENSE`](LICENSE) for the complete license text.

The AGPL-3.0 includes source-disclosure obligations for covered modified versions, including when such a version is made available for network use. It does not prevent the copyright holder from offering separate commercial licensing, subject to ownership and third-party license rights.

## Disclaimer

MIIA is provided for research, educational, and informational purposes only. It does not provide individualized financial, investment, tax, or legal advice. Financial markets involve risk, including the possible loss of capital. Past or simulated performance does not guarantee future results. Users are responsible for independently evaluating information and decisions.

---

# Español

## Descripción general

MIIA (Mano Invisible) es un sistema experimental de inteligencia de mercado, modular y multipropósito. Su objetivo es transformar información heterogénea del mercado en señales analíticas estructuradas y contexto para apoyar el análisis y la toma de decisiones.

La plataforma combina ingesta de datos de mercado, procesamiento de variables, modelos cuantitativos, análisis de texto y sentimiento, analítica orientada a carteras, backtesting, recopilación de feedback y una interfaz para usuarios.

MIIA es un proyecto de investigación e ingeniería. **No** es un broker, mercado, custodio ni asesor de inversiones registrado. Sus resultados son informativos y no deben interpretarse como asesoramiento financiero personalizado ni como garantía de rendimiento futuro.

## Capacidades principales

- **Procesamiento de datos de mercado:** ingesta y normalización de precios e información financiera desde fuentes externas.
- **Análisis cuantitativo:** cálculo de variables técnicas y estadísticas para los componentes analíticos.
- **Análisis de texto y sentimiento:** procesamiento de noticias financieras y textos relacionados para generar señales contextuales.
- **Ensamble de modelos:** combinación de resultados de múltiples componentes mediante una capa de coordinación.
- **Analítica de carteras:** generación de vistas orientadas a portafolios utilizando datos de instrumentos y contexto de riesgo configurable.
- **Backtesting y evaluación:** comparación de resultados de modelos con resultados históricos y métodos de referencia.
- **Feedback y monitoreo:** persistencia de decisiones, evaluación de resultados y supervisión del estado de los componentes.
- **Interfaz y APIs:** exposición de análisis seleccionados e información del sistema mediante endpoints y paneles.

## Arquitectura de alto nivel

MIIA utiliza una arquitectura modular y políglota:

```text
Datos externos de mercado y noticias
                 |
                 v
          Capa de ingesta
                 |
                 v
     Normalización y variables
                 |
                 v
  Módulos cuantitativos y de texto
                 |
                 v
       Coordinación / decisión
                 |
           +-----+-----+
           |           |
           v           v
       Persistencia   Feedback y
       de datos       evaluación
           |           |
           +-----+-----+
                 |
                 v
             APIs e UI
```

El sistema utiliza un patrón de comunicación orientado a mensajes para reducir el acoplamiento directo entre componentes. Redis se utiliza para mensajería y coordinación transitoria; una base de datos relacional almacena información persistente de la aplicación y del análisis.

## Tecnologías

La implementación documentada utiliza un stack políglota que incluye:

- **JavaScript / Node.js:** orquestación, APIs y servicios de aplicación.
- **Python:** procesamiento de datos, flujos analíticos y determinados componentes de modelos.
- **C++:** componentes computacionales orientados al rendimiento.
- **C# / .NET:** servicios seleccionados y componentes de integración.
- **Redis:** mensajería y coordinación transitoria.
- **Almacenamiento relacional compatible con MySQL:** persistencia de registros de aplicación y análisis.

Las versiones exactas, configuración de hosts, puertos, rutas del sistema de archivos, credenciales, direcciones de despliegue y procedimientos operativos no se publican intencionalmente en este README.

## Investigación y evaluación

MIIA incluye comparaciones offline entre modelos y un flujo de verificación de resultados en vivo. La documentación distingue entre:

1. **Experimentos offline:** evalúan familias de modelos sobre datos históricos.
2. **Observaciones en vivo:** evalúan resultados reales del sistema una vez transcurrido el horizonte de cada señal.
3. **Ventaja frente a una referencia:** compara el acierto direccional con una referencia simple basada en la dirección dominante del mercado.

Estas mediciones no son equivalentes. Un resultado offline no demuestra que el sistema en producción tenga el mismo rendimiento.

**Última lectura en vivo — 20 de noviembre de 2026, 20:30 CET (NYSE abierto), 103 días de medición, 50 instrumentos:**

| Métrica | Valor |
|---|---|
| Muestra efectiva (ventanas independientes de 48 h × instrumento) | 895 |
| Decisiones verificadas | 115.799 |
| Tasa de referencia | 53,5 % |
| Acierto direccional | 55,0 % |
| Ventaja frente a la referencia | **+1,5 pp** |
| Ventaja mínima detectable (banda de ruido) | ±3,3 pp |
| Ventaja estadísticamente significativa | **No** |
| Rank IC (Spearman por sesión, 28 ventanas) | +0,041 (mínimo detectable 0,114) — no significativo |

La ventaja es positiva pero queda **dentro de la banda de ruido**: la lectura correcta es *sin ventaja demostrable*. Una versión del rank IC neutralizada contra el mercado (+0,129, mínimo detectable 0,110) supera su banda, pero es un diagnóstico auxiliar, fue una de varias comparaciones y 28 ventanas son pocas; no debe leerse como evidencia de una ventaja confiable hasta que se sostenga con más datos. Esto no demuestra que exista una estrategia rentable.

**Reproducibilidad.** El sistema completo se puede reconstruir desde cero con los scripts de este repositorio: `scripts/deploy_linux.sh` (servidor Ubuntu) o `scripts/deploy_windows.ps1` (Windows), siguiendo `docs/INSTALACION.md`. Una instalación nueva mide con sus propios datos en vivo desde el primer día, así que sus números van a ser distintos de éstos; el método (métricas, orden de lectura y bandas de ruido) es el mismo.

La evaluación de MIIA continúa. Toda afirmación pública sobre rendimiento debería incluir fecha, definición de la muestra, referencia utilizada, costos, intervalo de incertidumbre y aclaración de si el resultado es offline o en vivo.

## ORDEN 7 del sistema de ETFs (25 de noviembre de 2026)

Después de ORDEN 6, una serie de simulaciones offline (sim43 a sim56) preguntó qué
puede predecir MIIA de verdad. La respuesta fue acotada: con cinco años de datos y
varias clases de activos, MIIA **no** predice qué ETF le va a ganar al promedio en
los próximos dos días mejor que el azar. Lo que **sí** se puede predecir es
**cuánto** se va a mover cada activo (la volatilidad viene en rachas), no **hacia
dónde**. ORDEN 7 del sistema de ETFs aplica sólo lo que esa evidencia respalda, sin
cortar la medición en vivo.

**Grupo A — desplegado: pronóstico de volatilidad a dos días**

| Dónde | Qué cambia |
|---|---|
| `MIIA/miia_chatbot.py` | Para cada ETF, un pronóstico de volatilidad EWMA (RiskMetrics, λ = 0,94) para los próximos dos días, y su relación con la volatilidad habitual. Viaja dentro de `/api/portfolio` como `volatilidad_2d` y en cada activo (`vol_2d_pct`, `ratio_vol`, `mas_movido`). |
| `scripts/chat_*.js`, `scripts/class25B.js` | La respuesta de riesgo del chat suma «movimiento típico de ±X % en los próximos dos días, más o menos de lo habitual: dice cuánto, no hacia dónde». |
| `scripts/publi_src/index.html` | Un recuadro «Próximos 2 días» en el panel Portfolio: los ETFs que se espera que se muevan más y menos de lo habitual. |

Por qué EWMA y no la cadena neuronal de MIIA: en `docs/simulaciones/sim56_volatilidad.py`
(50 ETFs, 5 años) el rank IC de «quién se va a mover más de lo habitual» fue
**+0,138** con EWMA, +0,123 con HAR y +0,115 con la cadena de MIIA, todos muy por
encima de un placebo (+0,041). Una fórmula de una línea es igual o mejor que las
redes, así que va la fórmula. Es **sólo informativo**: no entra en ninguna decisión
BUY/SELL ni en las métricas de la tesis.

Se despliega sin reiniciar el orquestador ni el módulo de decisión (el servicio
Python lo relanza su supervisor y el módulo del chat se reinicia solo), así que la
serie de medición en vivo no se corta.

**Grupo B — medido y descartado**

Sumarle al vector de mercado de `class10` la volatilidad de 1, 5 y 22 días se probó
en `docs/simulaciones/sim59_vector_volatilidad.py` antes de tocar producción:

| Pregunta | 22 dims (hoy) | 25 dims (+ volatilidad) | Diferencia pareada |
|---|---|---|---|
| Dirección a 2 días (lo que decide MIIA) | −0,006 | −0,012 | −0,005 ± 0,016 |
| Volatilidad a 2 días | +0,115 | +0,121 | +0,005 ± 0,007 |

Ninguna diferencia se distingue de cero. Cambiar el vector reiniciaría las redes y
cortaría la serie de la tesis sin ganar nada medible, así que **no** se aplica.
También quedó afuera pesar los portafolios por riesgo: exige un reinicio completo y
rompería el control de portafolios que usa el experimento.

---

## Seguridad y límites del repositorio público

El repositorio público está destinado a mostrar código reutilizable y documentación técnica de alto nivel, no a proporcionar acceso a producción.

Nunca deben publicarse:

- Contraseñas, claves API, tokens de acceso, secretos JWT, secretos OAuth ni credenciales de pago.
- Llaves privadas SSH, certificados, archivos de configuración privados ni archivos `.env`.
- Direcciones IP de producción, nombres internos de hosts, detalles de redes privadas ni puertos de servicios expuestos.
- Volcados de bases de datos, backups, registros de usuarios, logs, estados de modelos ni datasets privados.
- Identificadores de cuentas administrativas o incidentes operativos que revelen vías de ataque.
- Scripts de despliegue en producción sin revisión y adaptación para entornos genéricos.

Los ejemplos deben utilizar valores ficticios. La configuración de producción debe mantenerse en un gestor de secretos o entorno protegido. Si una credencial alguna vez fue subida a Git, debe revocarse o rotarse: eliminarla de la última versión no es suficiente. Antes de publicar, hay que revisar el historial completo de Git.

## Reproducibilidad

Este README no incluye comandos de despliegue en producción ni configuraciones reales de infraestructura. Una instalación pública reproducible debería documentarse por separado e incluir:

- Una configuración de ejemplo local con valores ficticios.
- Datos sintéticos o con licencia adecuada.
- Una base de datos y un broker de mensajería locales para desarrollo.
- Instrucciones explícitas de dependencias y compilación.
- Pruebas automatizadas que no llamen a servicios de producción ni consuman cuotas de APIs productivas.

## Contribuciones

Las contribuciones mediante issues y pull requests son bienvenidas. Antes de enviar cambios:

1. No incluir secretos, datos personales, logs de producción ni datasets propietarios.
2. Agregar o actualizar pruebas para los cambios de comportamiento.
3. Documentar supuestos y limitaciones conocidas.
4. No afirmar rendimiento predictivo sin una evaluación reproducible que lo respalde.

## Licencia

MIIA se distribuye bajo la licencia **GNU Affero General Public License v3.0 (AGPL-3.0)**. Consultá [`LICENSE`](LICENSE) para leer el texto completo.

La AGPL-3.0 establece obligaciones de disponibilidad del código fuente para versiones modificadas cubiertas por la licencia, incluso cuando se ofrecen mediante una red. No impide que el titular de los derechos ofrezca licencias comerciales separadas, sujeto a la titularidad del código y a los derechos de terceros.

## Aviso legal

MIIA se proporciona únicamente con fines de investigación, educación e información. No ofrece asesoramiento financiero, de inversión, fiscal ni legal personalizado. Los mercados financieros implican riesgos, incluida la posible pérdida del capital. El rendimiento pasado o simulado no garantiza resultados futuros. Cada usuario es responsable de evaluar de forma independiente la información y sus decisiones.
