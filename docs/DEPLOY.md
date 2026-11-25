# Deploy de MIIA — Linux (VPS) y Windows Server

Dos scripts dejan el sistema de **cero a en línea**, con todo: librerías,
base de datos, Redis, compilación de C++, build de .NET, la web, pm2, los
puertos y el firewall.

| Objetivo | Script | Lenguaje |
|---|---|---|
| **VPS Linux** (como Contabo, producción) | `scripts/deploy_linux.sh` | bash |
| **Windows Server** | `scripts/deploy_windows.ps1` | PowerShell |

Los dos son **idempotentes**: podés correrlos de nuevo sin romper nada (no
pisan la base si ya tiene tablas, no regeneran el cert ni duplican reglas de
firewall).

> ⚠️ **El stack es Linux-first.** Todo nació para Ubuntu (bash, Redis, systemd,
> pm2). El deploy de Linux es el camino probado. El de Windows hace su mejor
> esfuerzo, pero dos piezas son inherentemente frágiles en Windows (Redis y el
> build de C++) — ver la sección de Windows. **Si tu objetivo es un server
> Windows, lo más robusto suele ser correr el stack Linux dentro de WSL2** y
> usar `deploy_linux.sh`.

---

## Antes de empezar (vale para los dos)

1. **El código ya tiene que estar en el server** (git clone o scp). El repo es
   privado.
2. **Secretos**: el deploy crea un `.env` desde `operador/aprendizaje/config/.env.example`
   y completa solo la base y el `JWT_SECRET`. **Vos completás el resto**:
   claves de precios (`FINNHUB_KEY`…), noticias (`NEWSAPI_KEY`, `GOOGLE_CSE_*`…),
   `GEMINI_API_KEY`, OAuth de Google (`GOOGLE_CLIENT_ID/SECRET`) y Mercado Pago
   (`MP_*`, hoy pausado).
3. **DNS + Cloudflare**: el dominio (`miiaia.com`) tiene que apuntar a la IP del
   server **con el proxy de Cloudflare encendido** (nube naranja). Cloudflare
   hace el TLS público (443) y reenvía al origen en **8443**.

---

## Linux (VPS Ubuntu)

```bash
cd /opt/miia                      # donde subiste el código
bash scripts/deploy_linux.sh
```

Hace, en orden: paquetes base → Redis → MySQL 8 + base + usuario + **esquema
(36 tablas)** → Node 20 → Python + venv + torch(CPU) → .NET 9 → `npm install`
→ compila C++ (Linux) + .NET (Release) → `.env` + **certificado TLS** → build
de la web → **pm2** (arranca `miia` + boot) → **firewall** (en modo revisión).

**Interruptores** (variables de entorno):

```bash
USAR_PM2=0 bash scripts/deploy_linux.sh            # no configura pm2
APLICAR_FIREWALL=0 bash scripts/deploy_linux.sh    # no toca el firewall
INSTALAR_OLLAMA=1 bash scripts/deploy_linux.sh     # + motor de lenguaje local
CF_FIREWALL_AUTO=1 bash scripts/deploy_linux.sh    # aplica el firewall sin preguntar
DOMINIO=miotrodominio.com bash scripts/deploy_linux.sh
```

Por defecto el **firewall queda en modo revisión** (no cierra nada). Para
aplicarlo:

```bash
sudo bash scripts/firewall_cloudflare.sh --aplicar
```

> ⚠️ En un server **limpio** el firewall aplica bien. Si el server **ya tenía**
> reglas abiertas `80/443/8443 ALLOW Anywhere`, primero borralas (ufw usa la
> primera regla que coincide, así que una abierta anula a las de Cloudflare):
> `sudo ufw delete allow 8443 ; sudo ufw delete allow 80 ; sudo ufw delete allow 443 ; sudo ufw delete allow 3001`

### Verificar (Linux)

```bash
pm2 status                 # 'miia' en 'online'
pm2 logs miia --lines 80   # el arranque de los ~38 procesos
bash scripts/miia_check.sh # diagnóstico completo
```

---

## Windows Server

```powershell
# PowerShell COMO ADMINISTRADOR, en la carpeta del proyecto
cd C:\miia
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_windows.ps1
```

Usa **Chocolatey** para los runtimes, **Memurai** como Redis, **MSYS2/MinGW**
para el C++ y **pm2** (+ boot). Parámetros: `-NoFirewall`, `-NoPm2`,
`-WithOllama`, `-SkipCpp`, `-AplicarFirewall`, `-Dominio`.

Firewall en modo revisión por defecto; para aplicarlo:

```powershell
.\scripts\deploy_windows.ps1 -AplicarFirewall
```

### Las dos piezas frágiles de Windows

1. **Redis no existe nativo en Windows.** Se usa **Memurai** (Developer edition,
   gratis para dev/test). Para **producción real** conviene Memurai pago o,
   mejor, **Redis dentro de WSL2**. Si Memurai no queda corriendo, MIIA no
   arranca — resolvelo antes de seguir.
2. **El build de C++ con MinGW es el paso más delicado.** `redis-plus-plus` no
   está en los repos de MSYS2, así que se compila de fuente. Si el paso 8 falla,
   el resto del deploy igual queda; terminás el C++ a mano en una consola
   **MSYS2 MinGW64**:

   ```bash
   export PATH=/mingw64/bin:$PATH
   pacman -S --needed mingw-w64-x86_64-toolchain mingw-w64-x86_64-cmake \
     mingw-w64-x86_64-nlohmann-json mingw-w64-x86_64-spdlog mingw-w64-x86_64-fmt \
     mingw-w64-x86_64-hiredis
   # redis-plus-plus de fuente → instalar en /mingw64
   git clone --depth 1 https://github.com/sewenew/redis-plus-plus
   cmake -G "MinGW Makefiles" -S redis-plus-plus -B rpp-build \
     -DREDIS_PLUS_PLUS_BUILD_TEST=OFF -DCMAKE_INSTALL_PREFIX=/mingw64
   cmake --build rpp-build -j && cmake --install rpp-build
   # el proyecto (copia los binarios a scripts\)
   cd /c/miia/miia_cognitive
   cmake -G "MinGW Makefiles" -B build-mingw -DCMAKE_BUILD_TYPE=Release
   cmake --build build-mingw -j
   ```

   Trampa conocida: spdlog de MSYS2 trae `SPDLOG_FMT_EXTERNAL`, por eso hace
   falta `fmt` (ya está en la lista). Y poné **una sola** carpeta de MinGW en el
   PATH (`mingw64`, no `ucrt64` delante).

### Boot en Windows

El script usa `pm2-windows-startup`. Si da problemas, lo **robusto** es un
servicio con **NSSM**:

```powershell
nssm install MIIA "C:\Program Files\nodejs\node.exe" "C:\miia\operador\index.js"
nssm set MIIA AppDirectory C:\miia
nssm start MIIA
```

### La alternativa simple: WSL2

Si no querés pelear con Memurai y MinGW:

```powershell
wsl --install -d Ubuntu-24.04
# dentro de WSL:  cd /mnt/c/miia  &&  bash scripts/deploy_linux.sh
```

Es el mismo stack Linux probado, corriendo sobre el Windows Server.

---

## El certificado TLS del origen

El deploy genera un **self-signed** en `scripts/certs/{pen.key,certen.pem}` (la
carpeta está gitignored). Funciona porque **Cloudflare hace el TLS público** y
confía en el origen. Lo **mejor** es reemplazarlo por un **Cloudflare Origin
Certificate** (gratis, 15 años, desde el panel de Cloudflare → SSL/TLS → Origin
Server), y poner Cloudflare en modo **Full (strict)**. Guardás el cert como
`certen.pem` y la key como `pen.key` en esa carpeta.

---

## Checklist de secretos del `.env`

| Clave | Para qué | Obligatoria |
|---|---|---|
| `DB_PASS` | base de datos | ✅ (el deploy la genera) |
| `JWT_SECRET` | login/sesiones (≥32 chars) | ✅ (el deploy la genera) |
| `FINNHUB_KEY` (+ fallbacks) | precios | ✅ para que haya datos |
| `GEMINI_API_KEY` | chat — **sólo respaldo** (ver nota) | no (opcional) |
| `GOOGLE_CLIENT_ID/SECRET` | login con Google | para el login |
| `NEWSAPI_KEY`, `GOOGLE_CSE_*`, `BING_KEY` | noticias | recomendadas |
| `MP_*` | pagos (hoy PAUSADO) | no |

Después de completarlos: `pm2 restart miia --update-env`.

> **El chat NO usa Gemini por defecto.** Desde el 11-oct-2026 corre sobre un modelo
> local de código abierto (**Gemma 2 2B vía Ollama**), con `MIIA_LLM=local`. Para
> que el chat funcione bien hay que **instalar Ollama** (`INSTALAR_OLLAMA=1` en
> Linux, `-WithOllama` en Windows, o a mano con `scripts/instalar_ollama.sh`); si
> no, el chat cae a plantillas internas. Gemini queda sólo como respaldo si ponés
> `MIIA_LLM=auto` — y por eso `GEMINI_API_KEY` es opcional.

---

## Qué NO automatiza el deploy (a propósito)

- Las **claves de las APIs** (no las puede inventar).
- El **DNS/Cloudflare** (se configura en el panel de Cloudflare).
- El **Cloudflare Origin Certificate** (opcional pero recomendado).
- En Windows, la **descarga del modelo de Ollama** si no pasás `-WithOllama`.
- El **borrado de reglas de firewall viejas** en un server que no está limpio
  (ver la nota de arriba).
