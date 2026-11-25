#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edge_por_regimen.py — ¿MIIA tiene ventaja según el régimen del mercado?

La teoría de Martín (16-oct-2026): en regímenes ALCISTAS y LATERALES MIIA
presenta ventaja, pero en BAJISTAS y CRISIS no. Este script la pone a prueba
SEGMENTANDO las decisiones por el régimen que había CUANDO SE TOMÓ cada una
(la tendencia previa del mercado, no lo que pasó después), y midiendo la
ventaja por bucket EXACTAMENTE como la tesis:

    acierto   = correctas / total
    base_rate = max(subió, bajó) / total            (el azar de esa muestra)
    ventaja   = acierto − base_rate
    ruido     = 1,96 · raíz(0,25 / n_efectivo)        (banda de significancia)
    n_efectivo= ventanas de 48 h NO solapadas × instrumento distinto

La dirección realizada se reconstruye de senal+outcome_real:
    subió (el instrumento le ganó al promedio) = (BUY y correcto) o (SELL e incorrecto)

QUÉ ES Y QUÉ NO
  · Sólo LEE (SELECT). No toca procesos, state ni escribe nada. Mismo criterio
    que miia_check.sh.
  · El régimen es OBJETIVO: tendencia de la canasta equiponderada en las N
    sesiones previas a la decisión. NO usa la etiqueta de class13 (que es un
    input de MIIA: segmentar su desempeño por su propia etiqueta sería circular).

CÓMO SE CORRE (en el server, con el python del venv de MIIA)
    scp docs/planilla/edge_por_regimen.py root@TU_SERVER:/root/
    ssh root@TU_SERVER "/opt/miia/MIIA/venv/bin/python /root/edge_por_regimen.py"

OPCIONES
    --dias N          ventana de decisiones a leer (default 400)
    --trend N         sesiones de tendencia previa (default 20)
    --umbral P        |tendencia| < P → lateral      (default 0.02 = 2 %)
    --crisis P        tendencia < −P → crisis         (default 0.06 = 6 %)
    --modo M          'relativo' (default), 'ranking' (solo post-corte), 'todos'
    --root PATH       raíz de MIIA en el server (default /opt/miia)

⚠️ LECTURA HONESTA DE LA SALIDA
  · Una ventaja sólo cuenta si SUPERA su banda de ruido. Con n_efectivo chico la
    banda es enorme (±13 pp con n=50): un número grande ahí NO es señal.
  · Para que "alcista mejor que bajista" sea real, la DIFERENCIA entre los dos
    edges tiene que superar las dos bandas juntas. El script lo dice explícito.
  · base_rate NO es MIIA: es el mercado. Un edge que sube porque bajó la base no
    es mejora. Por eso se muestran los dos.
"""
import asyncio, math, os, sys
from pathlib import Path

# ── argumentos ───────────────────────────────────────────────
def arg(nombre, default, cast=str):
    if nombre in sys.argv:
        try: return cast(sys.argv[sys.argv.index(nombre) + 1])
        except Exception: pass
    return default

DIAS    = arg("--dias", 400, int)
TREND   = arg("--trend", 20, int)
UMBRAL  = arg("--umbral", 0.02, float)
CRISIS  = arg("--crisis", 0.06, float)
MODO    = arg("--modo", "relativo", str)
ROOT    = Path(arg("--root", os.getenv("MIIA_ROOT", "/opt/miia"), str))

# ── credenciales: el mismo .env que lee miia_chatbot (no se tipea nada) ──────
def cargar_env():
    p = ROOT / "operador" / "aprendizaje" / "config" / ".env"
    try:
        for ln in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln: continue
            k, v = ln.split("=", 1)
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)
    except Exception as e:
        print(f"[aviso] no pude leer {p}: {e}", file=sys.stderr)

cargar_env()
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASS = os.getenv("DB_PASS", "")
DB_NAME = os.getenv("DB_NAME", "miia_cognitiva")

LABELS = ["alcista", "lateral", "bajista", "crisis"]

def clasificar(tr):
    if tr is None:            return "s/d"
    if tr <= -CRISIS:         return "crisis"
    if tr <  -UMBRAL:         return "bajista"
    if tr >   UMBRAL:         return "alcista"
    return "lateral"

def banda(n_ef):
    return 1.96 * math.sqrt(0.25 / n_ef) * 100 if n_ef > 0 else float("inf")

async def main():
    import aiomysql
    _pw = DB_PASS.encode("utf-8").decode("latin1")  # mismo truco que el chatbot (ñ)
    pool = await aiomysql.create_pool(host=DB_HOST, port=DB_PORT, user=DB_USER,
                                      password=_pw, db=DB_NAME, charset="utf8mb4",
                                      autocommit=True, minsize=1, maxsize=4)

    async def q(sql, params=()):
        async with pool.acquire() as c:
            async with c.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(sql, params); return await cur.fetchall()

    # 1) Cierre diario por instrumento → retorno equiponderado de la canasta →
    #    índice acumulado por sesión. Los tickers de 'precios' SON el universo
    #    medible (los de texto no se cotizan).
    filas = await q(f"""
        SELECT t.ticker, t.f AS dia, p.precio
        FROM (SELECT ticker, DATE(ts) f, MAX(ts) mx
              FROM precios
              WHERE precio IS NOT NULL AND precio > 0
                AND ts >= NOW() - INTERVAL %s DAY
              GROUP BY ticker, DATE(ts)) t
        JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
        ORDER BY t.ticker, t.f
    """, (DIAS + TREND + 10,))
    por_dia, prev = {}, {}
    for r in filas:
        tk, dia, pr = r["ticker"], str(r["dia"]), float(r["precio"])
        if tk in prev and prev[tk] > 0:
            por_dia.setdefault(dia, []).append(pr / prev[tk] - 1.0)
        prev[tk] = pr
    dias_ord = sorted(por_dia)
    idx, acc = {}, 1.0
    for d in dias_ord:                       # índice de la canasta
        v = por_dia[d]
        acc *= (1.0 + (sum(v) / len(v)))
        idx[d] = acc
    pos = {d: i for i, d in enumerate(dias_ord)}

    def tendencia(dia):                      # retorno de las TREND sesiones previas
        i = pos.get(dia)
        if i is None or i < TREND: return None
        base = idx[dias_ord[i - TREND]]
        return idx[dia] / base - 1.0 if base else None

    # 2) Decisiones verificadas y direccionales de la población elegida.
    filtro = {"relativo": "AND label_modo='relativo'",
              "ranking":  "AND label_modo='relativo' AND decision_modo='ranking'",
              "todos":    ""}.get(MODO, "AND label_modo='relativo'")
    decs = await q(f"""
        SELECT ticker, senal, outcome_real,
               DATE(ts_decision) AS dia,
               FLOOR(UNIX_TIMESTAMP(ts_decision)/172800) AS win
        FROM cognitive_decisions
        WHERE senal IN ('BUY','SELL')
          AND outcome_real IN ('correcto','incorrecto')
          AND (temperatura IS NULL OR temperatura <> 'shadow')
          {filtro}
          AND ts_decision >= NOW() - INTERVAL %s DAY
    """, (DIAS,))

    # 3) Agregar por régimen.
    B = {k: {"n":0,"ok":0,"up":0,"wt":set()} for k in LABELS + ["s/d"]}
    for d in decs:
        reg = clasificar(tendencia(str(d["dia"])))
        correcto = d["outcome_real"] == "correcto"
        subio = (d["senal"]=="BUY") == correcto   # BUY&ok ó SELL&err → subió
        b = B[reg]; b["n"] += 1
        if correcto: b["ok"] += 1
        if subio:    b["up"] += 1
        b["wt"].add((d["win"], d["ticker"] or "GENERAL"))
    pool.close(); await pool.wait_closed()

    # 4) Imprimir.
    print(f"\n  edge por régimen · modo={MODO} · últimos {DIAS} d · "
          f"tendencia {TREND} sesiones · umbral ±{UMBRAL:.0%} · crisis <-{CRISIS:.0%}")
    print("  (ventaja en pp; 'ruido' = banda de significancia; ventaja REAL sólo si |ventaja| > ruido)\n")
    print(f"  {'régimen':9} {'n':>7} {'n_efec':>7} {'acierto':>8} {'base':>7} "
          f"{'ventaja':>8} {'ruido':>7}  veredicto")
    res = {}
    for k in LABELS + ["s/d"]:
        b = B[k]; n = b["n"]
        if n == 0:
            print(f"  {k:9} {'—':>7}"); continue
        acc  = b["ok"] / n
        base = max(b["up"], n - b["up"]) / n
        edge = (acc - base) * 100
        n_ef = len(b["wt"]); ru = banda(n_ef)
        sig  = "VENTAJA" if edge > ru else ("en contra" if edge < -ru else "dentro del ruido")
        res[k] = (edge, ru, n_ef)
        print(f"  {k:9} {n:>7,} {n_ef:>7,} {acc*100:>7.1f}% {base*100:>6.1f}% "
              f"{edge:>+7.1f} {ru:>6.1f}  {sig}")

    # 5) El contraste que pide la teoría: alcista+lateral  vs  bajista+crisis.
    def junta(ks):
        n=ok=up=0; wt=set()
        for k in ks:
            b=B[k]; n+=b["n"]; ok+=b["ok"]; up+=b["up"]; wt|=b["wt"]
        if n==0: return None
        acc=ok/n; base=max(up,n-up)/n
        return (acc-base)*100, banda(len(wt)), n, len(wt)
    a = junta(["alcista","lateral"]); d = junta(["bajista","crisis"])
    print("\n  — el contraste de la teoría —")
    if a and d:
        print(f"  alcista+lateral : ventaja {a[0]:+.1f} pp ± {a[1]:.1f}  (n={a[2]:,}, n_ef={a[3]:,})")
        print(f"  bajista+crisis  : ventaja {d[0]:+.1f} pp ± {d[1]:.1f}  (n={d[2]:,}, n_ef={d[3]:,})")
        dif = a[0] - d[0]; banda_dif = a[1] + d[1]
        if dif > banda_dif:
            print(f"  → diferencia {dif:+.1f} pp SUPERA la banda conjunta ({banda_dif:.1f}): "
                  "la teoría se sostiene en estos datos.")
        else:
            print(f"  → diferencia {dif:+.1f} pp NO supera la banda conjunta ({banda_dif:.1f}): "
                  "todavía no es distinguible del azar. Hace falta más muestra por régimen.")
    else:
        print("  sin muestra suficiente en algún lado todavía.")
    print("\n  Nota: base_rate es el mercado, no MIIA. Un régimen con n_efectivo < ~30 no")
    print("  concluye nada. Repetir a medida que se acumulen ventanas.\n")

if __name__ == "__main__":
    asyncio.run(main())
