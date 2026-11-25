# MIIA — Mano Invisible Inteligencia Artificial

> © 2025-2026 Martín Francisco Rinaldi Toledo · Registro DNDA (depósito de obra inédita —
> software), expediente **EX-2025-127876650- -APN-DNDA#MJ** · Código bajo **AGPL-3.0**,
> documentación bajo **CC BY-NC 4.0** — ver [`NOTICE.md`](../NOTICE.md).

> Presentación corta del proyecto: [`docs/PRESENTACION.md`](PRESENTACION.md). Documentación completa: [`docs/mapa del proyecto/`](mapa%20del%20proyecto/) y [`docs/Proyecto_MIIA_pdf_texto.txt`](Proyecto_MIIA_pdf_texto.txt).

> **La conclusión del experimento, con las mediciones, está en [`CONCLUSION.md`](../CONCLUSION.md).**

---

## Estado al 20-nov-2026

**MIIA sigue corriendo en producción** (miiaia.com). Desde el 10-oct-2026 (ORDEN 6) mide
sobre 50 instrumentos con ranking transversal y rank IC. Hasta ahora **no demostró ventaja**:
el rank IC y la ventaja contra el azar están dentro de su banda de ruido. Con 50 instrumentos
hacen falta ~51 ruedas para leer un veredicto, así que no se lee antes de **enero de 2027**.

**Este repo es privado por ahora.** Si MIIA se apaga (enero o febrero de 2027), se hace
público. En esta copia la IP del servidor, los emails y las claves están reemplazados por
valores de ejemplo (`TU_SERVER`, `admin@example.com`, `ca-pub-0000000000000000`). **No hay
ningún respaldo de la base de datos**: sólo el esquema vacío.

### Qué hay en el repo

| Dónde | Qué tiene |
|---|---|
| [`docs/INSTALACION.md`](INSTALACION.md) | Cómo levantar MIIA desde cero, en un servidor Ubuntu o en Windows |
| [`docs/PRESENTACION.md`](PRESENTACION.md) | Presentación corta: qué mide y cómo está armada |
| [`docs/mapa del proyecto/`](mapa%20del%20proyecto/) | La documentación completa (Word y PDF), en castellano (`Proyecto MIIA`) y en inglés (`MIIA_Project_EN`, con índice). En esta versión se omitió el detalle de los puntos de seguridad abiertos del servidor |
| [`docs/Proyecto_MIIA_pdf_texto.txt`](Proyecto_MIIA_pdf_texto.txt) | El texto del PDF, para buscar |
| [`CONCLUSION.md`](../CONCLUSION.md) | Cómo se cierra la medición |
| [`NOTICE.md`](../NOTICE.md) · [`LICENSE`](../LICENSE) | Autoría, registro DNDA y licencias (AGPL-3.0 el código, CC BY-NC 4.0 la documentación) |
| [`docs/esquema_miia_cognitiva.sql`](esquema_miia_cognitiva.sql) | Las 36 tablas, **sin datos** |
| `docs/simulaciones/` | Las pruebas en frío (`probar.ps1`), no necesitan el sistema corriendo |
| `docs/planilla/` | Herramientas de la lectura diaria |
| `scripts/deploy_linux.sh` · `deploy_server.sh` | Instalan todo en un Ubuntu limpio |
| `scripts/deploy_windows.ps1` · `redis/` | Instalación en Windows y Redis para Windows |
| `scripts/build_cpp_linux.sh` | Compilar los módulos C++ |
| `scripts/instalar_ollama.sh` · `scripts/ollama/` · `scripts/llm_local.js` | El motor de lenguaje local del chat: Ollama con `gemma2:2b` (sección 8b) |

Las notas internas de trabajo (las notas internas) no están incluidas. Si algo de acá no coincide
con el código, **gana el código**.

---

# MIIA — cómo desplegarla desde cero

Guía para levantar MIIA en un servidor nuevo a partir de este pen drive.
Escrita el 11-sep-2026 y actualizada el 20-nov-2026. Si algo de acá no coincide con el código, **gana el código**.

---

## El camino rápido: dos scripts que hacen TODO

> Agregado el 1-nov-2026, para que cualquiera —un dueño nuevo del repo, un equipo,
> alguien que no conoce el proyecto— pueda desplegar MIIA entera sin seguir los 11
> pasos a mano.

Desde octubre-2026 hay **dos scripts de deploy automático** que llevan un servidor
**nuevo** de cero a en línea haciendo todo lo que describen las secciones 0 a 11:
paquetes y librerías, Redis, MySQL + las **36 tablas**, Node, Python (+ torch CPU),
.NET, la **compilación de C++**, el certificado TLS, el build de la web, **pm2**
(con arranque al bootear) y el **firewall** (80/8443 sólo desde Cloudflare).

| Objetivo | Comando (en el servidor, dentro de la carpeta del proyecto) |
|---|---|
| **VPS Linux** (Ubuntu, como producción) | `bash scripts/deploy_linux.sh` |
| **Windows Server** | `powershell -ExecutionPolicy Bypass -File .\scripts\deploy_windows.ps1` (como **Administrador**) |

Son **idempotentes** (podés correrlos de nuevo sin romper nada) y **no pisan la
base** si ya tiene tablas. Generan solos la contraseña de la base y el
`JWT_SECRET`; el resto de los secretos (claves de precios, noticias, Gemini, OAuth,
Mercado Pago) los completás en `operador/aprendizaje/config/.env`, que el script
crea desde la plantilla **`operador/aprendizaje/config/.env.example`** (tiene cada
variable explicada).

**La guía completa de los dos scripts** —qué hace cada paso, el checklist de
secretos, los pasos manuales de Windows y la alternativa WSL2— **está en
[`docs/DEPLOY.md`](DEPLOY.md).**

> ⚠️ **Dos avisos:**
> 1. Son para un servidor **nuevo/limpio**. No los corras contra un server que ya
>    está corriendo una medición: el paso de pm2 reinicia el orquestador y **corta
>    la serie** (ver el aviso del experimento, arriba de todo).
> 2. **Windows es second-class**: Redis no tiene build nativo (se usa Memurai) y la
>    compilación de C++ con MinGW es frágil. Si el objetivo real es un server
>    Windows, lo más robusto es correr **WSL2** con `deploy_linux.sh` — está en
>    `docs/DEPLOY.md`.

Las secciones 0 a 11 de abajo son la **versión manual, paso a paso**: sirven para
entender cada parte, o si un script falla y hay que terminar algo a mano. El
firewall de los dos scripts queda en **modo revisión** hasta que le pases
`--aplicar` (Linux) / `-AplicarFirewall` (Windows).

---

## 0. Qué tiene que haber en el pen drive

| Qué | Dónde | Por qué importa |
|---|---|---|
| El repo de MIIA, con su historia (`.git`) | `D:\MIIA\` | El código. La rama `main` es lo que corría en producción |
| El esquema de la base | `D:\deploy_esquema_miia_cognitiva.sql` | Crea las 36 tablas. Sin esto la base no se rearma: el código crea sólo 3 |
| **Los secretos** | aparte (ver abajo) | No están en git, a propósito |
| Los datos y lo aprendido (opcional) | «Antes de apagar un server» | Sólo si querés seguir desde donde quedó |

Para poner el repo en el pen drive, desde GitHub (mientras el repo sea privado, pide iniciar sesión):

```bash
git clone https://github.com/martinrinaldi303/miia.git /d/MIIA
```

`git clone` copia sólo lo versionado (~200 archivos). No se lleva los 700 MB
de `node_modules`, ni el entorno de Python, ni los binarios de Windows, que en
Linux no sirven.

Tampoco se lleva **lo que los módulos escriben al correr** —`state/`, `logs/`,
`snapshots/`, `emociones/`, `central_bus/`, `models/`—, que está entero en
`.gitignore`. Es a propósito: se regenera solo, y una corrida local llega a dejar
**3.300 archivos y 13 MB** en esas carpetas. Si `git status` te muestra cientos de
archivos sin trackear después de levantar MIIA, falta una regla en `.gitignore`;
lo que hay que hacer es agregarla, **no** commitearlos.

### Lo que NO está en git y hay que guardar aparte

| Archivo | Qué tiene |
|---|---|
| `operador/aprendizaje/config/.env` | Todas las credenciales (lista abajo) |
| `operador/aprendizaje/config/sql.ini` | Credenciales de la base (el `.env` tiene prioridad) |
| `scripts/certs/` (`certen.pem`, `pen.key`) | El certificado HTTPS. `pen.key` es una **clave privada** |

Variables del `.env`: `DB_HOST DB_PORT DB_USER DB_PASS DB_NAME DB_ROOT_PASS
JWT_SECRET GEMINI_API_KEY GEMINI_MODEL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
GOOGLE_SEARCH_KEY GOOGLE_SEARCH_CX NEWSAPI_KEY FINNHUB_KEY ALPHAVANTAGE_KEY
POLYGON_KEY TWELVEDATA_KEY ADMIN_PASSWORD MP_PUBLIC_KEY MP_ACCESS_TOKEN
MP_CURRENCY MP_PRECIO_MENSUAL MP_PRECIO_ANUAL`, más un bloque de dominio
(`MIIA_ENV=production`, `PUBLIC_BASE_URL`…) que en producción va descomentado.

`JWT_SECRET` tiene que tener **32 caracteres o más**: si no, MIIA no arranca.

> Si el pen drive guarda estos archivos, tratalo como una llave: con eso se
> entra a la base, a Mercado Pago y a todas las APIs.

---

## 1. El servidor

- **Ubuntu 24.04** (el instalador acepta 20.04, 22.04 y 24.04).
- MIIA corría en 6 núcleos, 12 GB de RAM y 200 GB de SSD (Contabo, plan Cloud VPS 20 SSD). Con menos
  RAM, el LSTM y MySQL compiten.
- Acceso root por SSH.

### Swap: ponerlo antes de arrancar, no después

Contabo no trae swap. Sin él, cuando la memoria se agota el kernel mata al proceso
de mayor RSS —`mysqld` primero, `class44.py` después— y si le toca a un módulo que
no está en `CRITICAL_LABELS`, **queda muerto en silencio**. Son 30 segundos:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

Las tres líneas importan y la del medio es la que se olvida: **`swapon` solo no
sobrevive un reinicio del servidor**, así que sin la línea de `/etc/fstab` el swap
desaparece sin avisar la primera vez que el proveedor reinicie la VPS. Y
`swappiness=10` evita que Ubuntu (que viene en 60) mande a disco los 2 GB del
*buffer pool* de InnoDB, que es justo lo que no debe irse.

⚠️ **Leer `available`, no `free`, y no asustarse con el swap usado.** Unas decenas
de MB son el kernel moviendo páginas inactivas, no falta de memoria. La señal real
es swap por encima de ~500 MB o creciendo entre lecturas, o `available` por debajo
de 1 GB.

## 2. Subir el código

Desde Git Bash en Windows (cambiá la IP):

```bash
scp -r /d/MIIA root@IP_DEL_SERVER:/opt/miia
```

Todo el sistema asume que vive en **`/opt/miia`**. Esa carpeta tiene que NO
existir todavía: si existe, `scp` crea `/opt/miia/MIIA` adentro.

## 3. Instalar todo: `deploy_server.sh`

**Antes, poné el `.env` en `/opt/miia/operador/aprendizaje/config/`**: de ahí
saca el usuario y la clave de la base. Después, en el server:

```bash
cd /opt/miia && bash scripts/deploy_server.sh
```

Instala Redis, MySQL 8, Node 20, Python 3 con su entorno virtual (PyTorch para
CPU) y el SDK de .NET 9. Además compila los módulos C++ para Linux y crea la
base vacía con su usuario. Se puede correr más de una vez sin romper nada.

**Tiene tres huecos, que se completan a mano en los pasos que siguen:**

1. Compila el motor .NET en **Debug**, y producción usa **Release**.
2. Crea la base **vacía**, sin las tablas.
3. Al final dice que veas systemd en `DEPLOY_LINUX.md`. Ese archivo **no
   existe**, y MIIA corre con **pm2**, no con systemd.

## 4. Crear las tablas

```bash
scp /d/deploy_esquema_miia_cognitiva.sql root@IP_DEL_SERVER:/root/
```

y en el server:

```bash
sudo mysql < /root/deploy_esquema_miia_cognitiva.sql
```

Es seguro: no borra nada, sólo crea las tablas que falten. Para comprobar que
quedaron todas (tiene que dar **36**):

```bash
sudo mysql -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='miia_cognitiva'"
```

## 5. Certificados

Copiá `scripts/certs/` (con `certen.pem` y `pen.key`) a `/opt/miia/scripts/certs/`.
Sin eso el gateway (class30) no puede servir HTTPS.

## 6. Compilar los módulos C++ (class21 a class29)

Ocho módulos de la cadena cognitiva están escritos en C++ y viven en
`miia_cognitive/`: `class21`, `class22`, `class23`, `class24`, `class25A`,
`class27`, `class28` y `class29`. El orquestador los lanza como **ejecutables desde
`scripts/`**: si no están compilados ahí, esos ocho no arrancan y el sistema queda
sin cadena cognitiva — sin decisión, ni siquiera.

**Si corriste `deploy_server.sh`, esto ya está hecho**: ese script llama a
`scripts/build_cpp_linux.sh` (línea 106). Leé igual lo de abajo, que es lo que hace
falta cuando la compilación falló, cuando se instala a mano, o cada vez que se toca
un `.cpp`.

En el servidor (Linux):

```bash
cd /opt/miia && bash scripts/build_cpp_linux.sh
```

Ese script instala las dependencias —hiredis, redis-plus-plus, spdlog y
nlohmann/json— y compila. En Windows, para probar en la PC:

```bash
cd miia_cognitive && cmake -G "MinGW Makefiles" -B build && cmake --build build
```

**Dónde tienen que quedar.** El `POST_BUILD` del CMake los copia a `scripts/`
(`miia_cognitive/CMakeLists.txt:20`), que es donde el orquestador los busca. Si
compilás a mano, tienen que terminar igual en esa carpeta:

| Sistema | Qué genera el compilador | Dónde tiene que quedar |
|---|---|---|
| Linux | ejecutable **sin extensión**: `class21`, `class25A`, … | `scripts/class21`, `scripts/class25A`, … |
| Windows | `class21.exe`, `class25A.exe`, … | `scripts/class21.exe`, `scripts/class25A.exe`, … |

Dos cosas que cuestan tiempo si no se saben:

- **No son DLL ni bibliotecas.** En Linux son ejecutables ELF sin extensión, y cada
  uno corre como un proceso propio. El `.dll` no existe en ninguna de las dos
  plataformas.
- **El `.exe` de Windows NO corre en Linux.** No sirve copiarlo al servidor: hay
  que recompilar del mismo fuente allá. Para saber si un binario del servidor está
  al día, comparar su fecha con la del `.cpp`:

```bash
stat -c '%y %n' /opt/miia/scripts/class25A /opt/miia/miia_cognitive/class25A.cpp
```

Si el binario es más viejo que el `.cpp`, está corriendo código anterior al que hay
en el repo. Para recompilar **uno solo** sin parar nada: compilar ese target en el
servidor, reemplazar el binario y matar el proceso. Si está en `CRITICAL_LABELS`, el
orquestador lo relanza solo a los 8 s.

## 7. Compilar .NET en Release

```bash
cd /opt/miia/MIIA_MotoresVectoriales && dotnet build -c Release
```

Hacelo con MIIA **parada**: si está corriendo, el DLL está en uso y el build falla.

## 8. (Opcional) Recuperar lo aprendido

Si traés el respaldo de «Antes de apagar un server», antes de arrancar:

- `miia_state_FECHA.tar.gz` → descomprimir en `/opt/miia/operador/aprendizaje/`.
  Recupera `state/` y `models/`: los pesos de las redes, el neutro, la memoria
  bayesiana y el LSTM.
- La base con datos: ver esa misma sección.

Sin esto MIIA arranca de cero: vuelve a aprender y la serie de la tesis empieza
otra vez.

## 8b. El motor de lenguaje del chat — modelo local de código abierto (Ollama)

> **El chat corre sobre un modelo de lenguaje local de código abierto —Gemma 2 de
> 2B parámetros (`gemma2:2b`)— servido con Ollama dentro del propio servidor.** No
> necesita GPU ni API paga. Gemini es opcional: si hay clave, se usa primero para la
> charla libre y Ollama queda de respaldo.

### Cómo decide el chat quién contesta (estado al 20-nov-2026)

| Qué pregunta el usuario | Quién contesta |
|---|---|
| **Datos de MIIA** (ranking, riesgo, acierto, portafolio, mercado abierto…) | el **router de intenciones** (`chat_router.js` + `chat_redactor.js`): respuesta armada con los números del sistema, en ~50 ms, sin modelo de lenguaje |
| **Charla libre** (opiniones, temas fuera del mercado) | **Gemini** si hay clave y cupo (tope 9 s) y **Ollama** en paralelo (tope 20 s), en carrera; si los dos fallan, una respuesta interna |
| Sin Gemini (sin clave o sin cupo) | sólo Ollama |
| Sin Ollama | redactor interno de plantillas |

Todo lo que escribe un modelo pasa por un **validador** (`chat_evidencia.js`): se
descarta si inventa un número, aconseja comprar o vender, nombra el proveedor o viene
cortado. El modelo nunca decide BUY/SELL: el motor de lenguaje **no toca la tesis**.

### El motor local, en números

| | valor |
|---|---|
| modelo | `gemma2:2b` (1,6 GB en disco, ~1,8 GB en RAM cargado) |
| velocidad medida (6 vCPU) | lee el prompt a ~25 ms/token, genera a ~100 ms/token |
| contexto | 2.048 tokens (`MIIA_LLM_CTX`) |
| cuánto queda cargado | 60 min sin uso (`MIIA_LLM_KEEPALIVE=60m`, pisa al del servicio) |
| precalentado | class25B lo precarga con cada mensaje del chat (`MIIA_LLM_PRECALENTAR`) y systemd al arrancar Ollama (`scripts/ollama/10-prewarm.conf`) |
| cliente | `scripts/llm_local.js`: `node:http`, sin dependencias, cortacircuitos propio |

MIIA usa un LLM en **un solo lugar: el chat**. Las decisiones y las alertas se
redactan con una plantilla interna (`GEMINI_SOLO_USUARIO=1`, el default desde el
13-sep-2026), así que el motor de lenguaje **no toca la tesis, ni el ranking, ni
una fila de `cognitive_decisions`**. Por eso se puede cambiar sin cortar la serie.

Con el default `MIIA_LLM=local`, si Ollama no está, el chat cae al **redactor
interno** de plantillas — **no** a Gemini. Por eso **instalar Ollama no es
opcional para tener un chat de verdad**: es el motor por defecto. (Antes del
11-oct el chat salía por Gemini y gastaba entre 92 y 180 eventos de "sin cupo" por
día; eso es justo lo que este cambio eliminó.)

```bash
scp scripts/instalar_ollama.sh root@TU_SERVER:/root/
ssh -t root@TU_SERVER "bash /root/instalar_ollama.sh --revisar"   # sólo mira, no instala
ssh -t root@TU_SERVER "bash /root/instalar_ollama.sh"             # instala
```

`--revisar` es preflight puro: RAM, disco, puerto, systemd. La instalación pide
confirmación antes de bajar nada —el instalador oficial de Ollama es un script
remoto que corre como root— y deja escrita la alternativa auditable.

Después afina las tres variables que deciden el consumo, en un override de
systemd (`/etc/systemd/system/ollama.service.d/miia.conf`):

| variable | valor | por qué |
|---|---|---|
| `OLLAMA_HOST` | **127.0.0.1:11434** | 🔒 el 8443 está abierto y Cloudflare se saltea por IP: un Ollama en `0.0.0.0` sería **un LLM abierto a internet**. El script verifica con `ss -ltn` y falla si no escucha sólo en loopback |
| `OLLAMA_KEEP_ALIVE` | 5m | el modelo se descarga de RAM a los 5 min sin pedidos. ⚠️ MIIA manda `keep_alive: 60m` en cada pedido, así que con el chat en uso queda cargado una hora |
| `OLLAMA_NUM_PARALLEL` | 1 | cada slot reserva su **propio** KV cache: con el default la RAM se multiplica por 4 sin que nadie lo pida |

El modelo es **`gemma2:2b`** (1,6 GB en disco, 1,8 GB cargado). Medido en este
server el 11-oct-2026, con Ollama reportándose a sí mismo: **lee el prompt a
24,7 ms por token y genera a 102,8 ms por token**.

⚠️ **Esos dos números mandan sobre el diseño del prompt, no son un detalle.** El
chat entra por `/api/ask`, que espera **22 segundos** y después se rinde; a ese
ritmo, un prompt de 1.000 tokens se come 25 s sólo en leerse y el chat queda mudo
— pasó el 11-oct. Por eso el camino local usa un prompt compacto (~204 tokens) y
un tope de salida de 90, y `sim32` sección 7b rehace la cuenta en cada corrida.

**El chat contesta en ~15 s, contra 2-5 s de Gemini, y en 2 o 3 oraciones.** Ése
es el precio de no depender de la cuota, junto con que un 2B escribe peor que
`gemini-2.5-flash`.

Para que el modelo quede caliente después de reiniciar Ollama o la VPS:

```bash
scp scripts/ollama/10-prewarm.conf root@TU_SERVER:/etc/systemd/system/ollama.service.d/
ssh root@TU_SERVER "systemctl daemon-reload && systemctl restart ollama && ollama ps"
```

Para Gemini (opcional): `GEMINI_API_KEY` y `GEMINI_MODEL` en el `.env` (hoy
`gemini-3.8-flash`; Google retira modelos seguido, si da 404 hay que poner el flash
vigente). `CLASS25B_CHARLA_GEMINI=0` deja la charla sólo en Ollama.

Del lado de MIIA no hay nada que instalar: `scripts/llm_local.js` usa `node:http`
y **no agrega una sola dependencia**. El motor se elige con `MIIA_LLM`:

| valor | qué hace |
|---|---|
| **`local`** (default desde el 11-oct-2026) | sólo Ollama; si falla, el redactor interno. Decisión de Martín: con `auto` el chat seguía gastando cuota de Gemini |
| `auto` | local primero, Gemini de respaldo, redactor interno al final |
| `gemini` | el comportamiento anterior, bit a bit — la reversa exacta |

Para cambiar el cliente en un server que ya está corriendo: copiar
`scripts/llm_local.js` y `scripts/class25B.js` y matar class25B (está en
`CRITICAL_LABELS`: vuelve en 8 s). Copiar primero `llm_local.js`, o class25B
no arranca.

## 9. Arrancar con pm2

```bash
npm install -g pm2
cd /opt/miia && pm2 start operador/index.js --name miia
pm2 save && pm2 startup
```

`pm2 startup` imprime un comando: **copialo y correlo**. Así MIIA vuelve sola
después de un reinicio del server.

El arranque completo tarda, porque el orquestador levanta ~38 procesos en
etapas. En los primeros 30-60 s el panel puede dar 502; es normal.

## 10. Red, firewall y Cloudflare

La única entrada pública de MIIA es **class30, en el puerto 8443** (HTTPS). Todo
lo demás escucha sólo dentro del propio server: MySQL (3306), Redis (6379),
Python (5005), el dashboard (3001) y la UI (8088).

### Abrir los puertos (el firewall de Ubuntu, `ufw`)

**Primero el 22, siempre antes de `ufw enable`.** Si activás el firewall sin haber
abierto el SSH, te quedás afuera del server, y sólo se puede entrar por la
consola VNC del panel de Contabo.

```bash
ufw allow 22/tcp && ufw allow 8443/tcp && ufw enable
```

`ufw enable` pregunta si seguir: respondé `y`. Para ver cómo quedó:

```bash
ufw status numbered
```

**No abrir** ninguno de estos, aunque algo "no conecte":

| Puerto | Qué es | Por qué no |
|---|---|---|
| 3306 | MySQL | la base quedaría expuesta a internet |
| 6379 | Redis | el bus interno quedaría expuesto |
| 5005 | Python (FastAPI) | permite saltearse class30 y su control de acceso |
| 3001 | dashboard Socket.IO | no tiene autenticación |
| 8088 | UI del orquestador | es un panel interno |
| 80 | HTTP | sirve el sitio sin cifrar. |

### El firewall del panel de Contabo

Contabo trae un firewall propio en el panel (el VPS → pestaña **Firewall**), aparte
de `ufw`. Si lo activás, abrí ahí también el **22** y el **8443**. Si no lo
activás, manda sólo `ufw`.

### Cloudflare

- El DNS de `miiaia.com` tiene que apuntar a la IP nueva, **con el proxy
  activado** (la nube naranja).
- **Verificar** en el panel actual de Cloudflare cómo está hecho el paso de 443
  (lo que ve el visitante) a 8443 (donde escucha class30), y copiarlo igual.

### Recomendado: que al 8443 sólo entre Cloudflare

Con el 8443 abierto a todo el mundo, cualquiera entra al sitio directo por la IP y
se saltea Cloudflare: su firewall, su límite de pedidos y su protección contra
ataques. Para dejarlo abierto sólo a las IPs de Cloudflare:

```bash
for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do ufw allow proto tcp from "$ip" to any port 8443; done
```

y recién después borrar la regla general:

```bash
ufw delete allow 8443/tcp
```

- Hacerlo **después** de comprobar que el sitio anda por el dominio: desde ese
  momento `https://IP:8443` deja de responder, también para vos.
- Cloudflare cambia sus rangos de vez en cuando. Si un día el sitio no carga,
  volvé a correr el `for`.

## 11. Verificar que anda

```bash
cp /opt/miia/scripts/miia_check.sh /root/ && bash /root/miia_check.sh
```

Imprime `[OK]`, `[S/D]`, `[ALERTA]` o `[BUG]` por sección. Con el mercado
cerrado, muchos `[S/D]` y hasta un `[BUG]` de "todo GENERAL" son normales:
repetirlo con la bolsa abierta (de 10:30 a 17:00 hora argentina mientras rige
el horario de verano de EE. UU.; en su invierno, de 11:30 a 18:00).

Dónde leer los logs:
- `pm2 logs miia`, o `/opt/miia/logs/index.log`, donde escriben todos los
  módulos, cada uno con su etiqueta.
- `/opt/miia/operador/aprendizaje/logs/`, donde cada módulo guarda su propio log.

---

# Levantar la copia local (Windows)

> Esto es para **desarrollo** —probar en la PC sin tocar producción—, **no** es el
> deploy de un Windows Server. Para desplegar MIIA entera en un Windows Server, usá
> `scripts/deploy_windows.ps1` (ver «El camino rápido» arriba y `docs/DEPLOY.md`).

Para probar en la PC sin tocar producción. **La copia local está aislada**: el
orquestador tiene la URL de Redis fija en `redis://localhost:6379`
(`operador/index.js:256`) y el `.env` local trae `DB_HOST=localhost`, así que no
puede hablarle al bus ni a la base del servidor. Vale la pena verificar esas dos
cosas antes de arrancar, igual.

## 1. Arrancar Redis PRIMERO. No es opcional

```bash
cd redis && ./redis-server.exe --bind 127.0.0.1 --port 6379
```

y en otra consola, desde la raíz del repo:

```bash
node operador/index.js
```

**Por qué en ese orden, y no al revés.** El orquestador sabe levantar Redis solo
—el binario está en `redis/`—, pero antes hace **10 pings con un segundo entre
cada uno**, y durante esos ~10 segundos **no imprime una sola línea**. Lo único
que se ve es esto, que viene del Árbitro y asusta:

```
[ÁRBITRO] Iniciando...
⚠️ Árbitro SUB:          ← el mensaje viene VACÍO
⚠️ Árbitro SUB:
```

**Ese mensaje vacío significa exactamente una cosa: Redis no está escuchando.**
(Es un `AggregateError` de Node, que no trae texto.) Parece colgado y no lo está:
a los 10 s dice «⏳ Redis no respondió — se intenta levantarlo» y arranca solo.

El 22 y el 25-sep eso costó cuatro arranques fallidos seguidos: se cortaba con
Ctrl+C **un segundo antes** de que se arreglara solo. Y hay un bucle que lo
empeora — `shutdown.ini` trae **`kill_redis = true`**, así que cada apagado limpio
mata Redis y el arranque siguiente vuelve a empezar con los diez segundos mudos.

> **Cómo saber si está apagándose y no colgado:** buscar `📡 Canales Redis cerrados`
> en el log. Esa línea sólo se escribe dentro de `apagadoMaestro()`, y esa función
> sólo se dispara con SIGINT, SIGTERM o SIGHUP. Si aparece, alguien lo cortó
> (Ctrl+C o cerrar la ventana): **el código no se apaga solo por un error**, los
> deja pasar con la etiqueta `[NO CAPTURADO]`.

## 2. La librería de Redis de Python tiene que ser 5.x

El Redis que trae el repo para Windows es **5.0.14** (no hay build nativo más
nuevo de ese fork). `redis-py` 6 en adelante saluda en **RESP3** con el comando
`HELLO`, que **apareció en Redis 6**. Con `redis` sin pinear en
`requirements.txt`, el venv se instala con la 8.x y el resultado es:

```
[BOTCHAT] ❌ Redis: unknown command `HELLO`, with args beginning with: `3`
[class44/WARNING] Feedback listener error: unknown command `HELLO` — retry 10s
```

El chatbot y el LSTM **nunca logran suscribirse** y reintentan para siempre. No es
un fallo de arranque: MIIA levanta igual y el defecto queda en el log.

```bash
./MIIA/venv/Scripts/python.exe -m pip install "redis==5.2.1"
```

**En el servidor no pasa** (Ubuntu 24.04 trae Redis 7), así que es un pin del venv
local, no del repo. El arreglo de fondo es un Redis ≥ 6 en Windows —Memurai, WSL o
Docker— para que lo local se parezca a producción.

## 3. Qué tiene que quedar escuchando

| Puerto | Qué |
|---|---|
| 3306 | MySQL (XAMPP; el orquestador lo arranca solo) |
| 6379 | Redis |
| 5005 | `miia_chatbot.py` |
| 3001 | class46, dashboard |
| 8088 | UI del orquestador |
| 8443 | class30, el gateway (HTTPS) |

Un arranque completo son ~45 procesos: 27 de Node, los 8 binarios C++, Python y
.NET. El orquestador cierra con `✅ MIIA System v2.0.0 completamente operativo`.

## 4. Dos trampas al apagar

- **`kill_python` y `kill_dotnet` están en `true`** (`shutdown.ini`), y el apagado
  ejecuta `taskkill /F /IM python.exe`. Eso mata **todos** los Python y .NET de la
  máquina, no sólo los de MIIA. Si tenías un Jupyter abierto, se va con ella.
- **`logs/index.log` local NO es evidencia de producción.** Acumula corridas de
  prueba con flujo degradado y ya llevó a conclusiones falsas. Las fuentes de
  verdad son la tabla `cognitive_decisions`, `/api/backtesting/professional` y el
  `index.log` del servidor.

---

# Probar un cambio antes de desplegarlo

Los testers de flujo (`scripts/class8.js` y compañía) necesitan el sistema
corriendo. Las **simulaciones** de `docs/simulaciones/` no: corren en la PC,
contra datos reales del volcado, sin tocar producción, y **ejecutan el código real
de los módulos** en vez de reimplementarlo.

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\simulaciones\probar.ps1
```

Compila y corre once pruebas —las de Node y, si encuentra MinGW64, las de C++— e
imprime una tabla de resumen. Devuelve 0 si pasa todo. Si falta el compilador lo
dice y corre igual las de Node.

**Cómo se prueba el código de producción sin levantar el sistema:** los módulos JS
aceptan `CLASS43_SOLO_MODULO=1`, que los importa sin arrancar Redis ni MySQL, y
exponen `_test.setSql()` para inyectar una base falsa. Los C++ ponen su `main()`
bajo `#ifndef MIIA_SIN_MAIN`, así que una simulación puede **incluir el `.cpp` de
producción** y llamar a sus funciones. El detalle está en `docs/simulaciones/`.

⚠️ **Lo que estas pruebas NO prueban.** Dicen que el mecanismo quedó bien, no que
el sistema vaya a predecir mejor: eso es empírico y lo contesta la corrida, no un
test. No confundir «el test pasa» con «el sistema mejoró».

---

## Antes de apagar un server: bajar todo

Se hace con MIIA corriendo, sin reiniciar nada. En el server:

```bash
mysqldump --single-transaction --routines --triggers miia_cognitiva | gzip > /root/miia_datos_$(date +%F).sql.gz
tar czf /root/miia_state_$(date +%F).tar.gz -C /opt/miia/operador/aprendizaje state models
ls -lh /root/miia_*.gz
```

Y desde Git Bash, al pen drive:

```bash
scp root@IP_DEL_SERVER:'/root/miia_*.gz' /d/
scp root@IP_DEL_SERVER:/root/tesis_semanal.csv /d/
scp -r root@IP_DEL_SERVER:/opt/miia/scripts/certs /d/certs
scp root@IP_DEL_SERVER:/opt/miia/operador/aprendizaje/config/.env /d/env_miia
scp root@IP_DEL_SERVER:/opt/miia/operador/aprendizaje/config/sql.ini /d/
```

- La base ocupa ~12 GB en disco. Comprimida baja mucho, pero mirá el tamaño que
  muestra el `ls -lh` antes de copiar: el pen drive tiene 15 GB.
- **Ojo al restaurar:** este dump con datos **sí** trae un `DROP TABLE` por
  tabla. Se carga en una base vacía, nunca encima de una que esté en uso:
  `gunzip < miia_datos_FECHA.sql.gz | sudo mysql miia_cognitiva`

---

## Lo que no está en ningún manual (y costó aprenderlo)

- **Reinicio quirúrgico.** Los módulos de `CRITICAL_LABELS` (REDIS, PYTHON,
  MOTORVECTORIAL, CLASS1, CLASS21-24, CLASS25A, CLASS25B, CLASS27-29, CLASS43)
  vuelven solos a los 8 s si se los mata. Para desplegar un cambio en uno de
  ellos alcanza con matar ese proceso. Desde nov-2026 también CLASS9, CLASS11,
  CLASS14 y CLASS32. Los que no están en la lista
  (class30, class37, class46…) quedan **muertos en silencio**: esos piden
  `pm2 restart miia`.
- **Nunca `pkill -f "/opt/miia"`**: se mata a sí mismo, porque su propia línea
  de comando contiene el patrón. Usar el corchete: `pkill -f "[/]opt/miia"`.
- **No reiniciar class25A en la hora previa a la calibración del neutro**, que
  corre cada 72 h. Si la ventana no llegó a 500 muestras, la calibración se
  omite y se pierden 72 h.
- **Después de reiniciar class25A, el umbral vuelve a 0,42**, porque no se
  guarda en disco. Durante unas horas la mezcla de BUY/SELL/HOLD no es
  comparable con la de antes.
- **La web se edita en `scripts/publi_src/`**, no en `publi/`. Después:
  `node scripts/build_publi.js` y copiar `scripts/publi/` al servidor. No
  necesita reinicio.
- **Actualizaciones automáticas de Ubuntu:** el 26-ago-2026, un reinicio de
  `mysqld` hecho por `unattended-upgrades` tumbó MIIA. Hay que decidir qué hacer
  con ellas: desactivarlas deja el server sin parches de seguridad; lo
  intermedio, que es lo que se hizo, es excluir MySQL, Redis y el kernel
  (`Package-Blacklist`) y actualizarlos a mano una vez por mes.
- **Git en el server:** si el paso 2 copió el repo con `.git`, `/opt/miia` es un
  repo, y `git status` muestra qué se cambió a mano en producción.
