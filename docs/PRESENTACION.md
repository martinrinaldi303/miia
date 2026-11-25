# MIIA — Mano Invisible Inteligencia Artificial

Sistema políglota de análisis de mercado sobre **50 ETF de renta variable listados en EE.UU.**
Unos 60 módulos en **JavaScript, C++, C# y Python** que se comunican **sólo** por Redis pub/sub.
Corre en producción y sirve una web con paneles, chat y backtesting.

> ⚠️ **MIIA no es un asesor financiero y todavía no demostró ventaja sobre el mercado.**
> Este repositorio muestra la arquitectura y, sobre todo, **cómo se mide** si un sistema así
> tiene o no información. Los resultados se publican con su banda de ruido, también cuando
> no favorecen al sistema.

---

## La pregunta que se mide

Para cada instrumento y cada rueda: **¿le va a ir mejor o peor que al promedio de los 50?**
Es una pregunta *relativa* (transversal), no «¿sube o baja el mercado?».

- **Decisión:** ranking transversal. BUY a los *k* mejores, SELL a los *k* peores, el resto HOLD.
  La mezcla queda 50/50 por construcción y el movimiento común del mercado se cancela.
- **Métrica principal: rank IC** por ventana (Spearman entre el orden de MIIA y el orden real
  del día siguiente), leído **siempre** junto a su mínimo detectable.
- **Ventaja contra el azar con la misma mezcla** (acuerdo por azar de Cohen), no contra un
  porcentaje fijo: un sistema sin información de un solo lado da 0, no un número inflado.
- Orden de lectura obligatorio: `n_efectivo → mínimo detectable → significativo → ventaja`.

---

## Arquitectura

```
fuentes de precios y noticias
   └→ class7 (precios) · class1 (noticias) · class11 (impacto) · class13 (régimen)
         └→ class10 / class18 (C#, vectores por instrumento)
               └→ class19 (filtro de calidad)
                     ├→ class21 (filtro adaptativo, C++)
                     ├→ class22 (filtro rígido, C++)        en paralelo,
                     ├→ class23 (red neural, C++)           1/4 del voto cada uno
                     └→ class24 (MLP online, C++)
                           └→ class25A (decisión: ranking transversal, C++)
                                 └→ class25B (texto y chat, JS)
class43 verifica cada decisión contra el precio real y devuelve el resultado a las redes.
```

- **Ningún módulo importa a otro:** todo pasa por canales `classN_output`, `classN_ingest`,
  `classN_feedback`. Un módulo se puede reemplazar en caliente.
- **`operador/index.js`** es el orquestador: levanta Redis, MySQL, los módulos JS, el motor .NET,
  los binarios C++ y los servicios Python, y relanza los críticos si mueren.
- **`class30.js`** es la única entrada pública (HTTPS/WS), con sesión obligatoria por Google.
- **`MIIA/`** tiene el backend FastAPI (`miia_chatbot.py`, con la métrica de la tesis) y el
  LSTM (`class44.py`, en sombra: predice pero no vota hasta superar al azar).
- **Chat:** router de intenciones determinístico que contesta con números del sistema; un modelo
  local (Ollama) o Gemini sólo redactan, y todo lo que escriben pasa por un validador.

| Carpeta | Qué hay |
|---|---|
| `scripts/` | módulos JS, motores C#, el gateway, la web (`publi_src/`) |
| `miia_cognitive/` | la cadena cognitiva en C++ (class21-29) |
| `MIIA_MotoresVectoriales/` | proyecto .NET que compila los motores C# |
| `MIIA/` | servicios Python |
| `operador/` | orquestador y configuración (`config/*.ini`, `universo.json`) |
| `docs/simulaciones/` | ~40 pruebas en frío que ejecutan el código real sin levantar el sistema |
| `docs/esquema_miia_cognitiva.sql` | esquema completo de la base |

---

## Cómo correrlo

Requisitos: Node 20, Python 3.11+, .NET 8, un compilador C++ con hiredis/redis-plus-plus/spdlog,
Redis y MySQL 8.

```bash
cp operador/aprendizaje/config/.env.example operador/aprendizaje/config/.env   # completar
python -m venv MIIA/venv && MIIA/venv/bin/pip install -r MIIA/requirements.txt
bash scripts/build_cpp_linux.sh
(cd MIIA_MotoresVectoriales && dotnet build -c Release)
node operador/index.js
```

## Pruebas en frío

No necesitan el sistema corriendo: importan el código de producción (con interruptores tipo
`CLASS43_SOLO_MODULO=1` o `-DMIIA_SIN_MAIN` en C++) y lo ejercitan contra datos reales extraídos.

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\simulaciones\probar.ps1
```

```bash
node docs/simulaciones/sim42_sesion.js
bash docs/simulaciones/build_sim9.sh
```

## Autor

Martín Rinaldi.
