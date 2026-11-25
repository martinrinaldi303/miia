#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Diagnóstico de _riesgo_activos: corre la consulta exacta del chatbot y dice
por qué el riesgo por activo no aparece. Sólo LEE. Se corre en el server:
    scp docs/planilla/probar_riesgo.py root@TU_SERVER:/root/
    ssh root@TU_SERVER "/opt/miia/MIIA/venv/bin/python /root/probar_riesgo.py"
"""
import asyncio, os, sys
from pathlib import Path

ROOT = Path(os.getenv("MIIA_ROOT", "/opt/miia"))
VENTANA = 60

def cargar_env():
    p = ROOT / "operador" / "aprendizaje" / "config" / ".env"
    for ln in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

cargar_env()
sys.path.insert(0, str(ROOT / "MIIA"))
try:
    from universo import TICKERS as UNIVERSO
except Exception as e:
    print(f"[!] no pude importar universo: {e}"); UNIVERSO = []

async def main():
    import aiomysql
    pw = os.getenv("DB_PASS", "").encode("utf-8").decode("latin1")
    pool = await aiomysql.create_pool(
        host=os.getenv("DB_HOST", "localhost"), port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"), password=pw,
        db=os.getenv("DB_NAME", "miia_cognitiva"), charset="utf8mb4",
        autocommit=True, minsize=1, maxsize=2)

    print(f"universo: {len(UNIVERSO)} tickers")
    etfs  = tuple(sorted(UNIVERSO))
    marks = ",".join(["%s"] * len(etfs))

    async with pool.acquire() as c:
        async with c.cursor(aiomysql.DictCursor) as cur:
            try:
                await cur.execute(f"""
                    SELECT t.ticker, p.precio
                    FROM (SELECT ticker, DATE(ts) f, MAX(ts) mx
                          FROM precios
                          WHERE precio IS NOT NULL AND precio > 0
                            AND ts >= NOW() - INTERVAL %s DAY
                            AND ticker IN ({marks})
                          GROUP BY ticker, DATE(ts)) t
                    JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
                    ORDER BY t.ticker, t.f
                """, (VENTANA + 5,) + etfs)
                rows = await cur.fetchall()
            except Exception as e:
                print(f"\n[!!!] LA CONSULTA DIO ERROR: {type(e).__name__}: {e}")
                print("      → por eso _riesgo_activos devuelve {} y todo cae al fallback.")
                pool.close(); await pool.wait_closed(); return

    series = {}
    for r in rows:
        series.setdefault(r["ticker"], []).append(float(r["precio"]))

    print(f"la consulta devolvió {len(rows)} filas, {len(series)} tickers con datos\n")
    print(f"  {'ticker':8} {'días':>5}  {'¿pasa (>=10)?':12}  vol anual / drawdown")
    ok = 0
    for tk in sorted(series):
        px = series[tk]; n = len(px)
        if n < 10:
            print(f"  {tk:8} {n:>5}  {'NO (<10)':12}")
            continue
        rets = [px[i]/px[i-1]-1 for i in range(1, n) if px[i-1] > 0]
        m = sum(rets)/len(rets); var = sum((x-m)**2 for x in rets)/(len(rets)-1)
        vol = (var**0.5)*(252**0.5)
        pico, dd = px[0], 0.0
        for v in px:
            if v > pico: pico = v
            cc = (pico-v)/pico if pico > 0 else 0
            if cc > dd: dd = cc
        ok += 1
        print(f"  {tk:8} {n:>5}  {'sí':12}  vol {vol*100:4.0f}%  dd {dd*100:4.0f}%")
    print(f"\n{ok} tickers con vol calculada. Si es 0, el umbral <10 días es la causa "
          f"(subir historia o bajar el umbral). Si hay varios, el problema es otro.")
    pool.close(); await pool.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())
