"""sim39 — el rank IC y la beta (16-nov-2026).

Pedido de Martín: «revisá que el rank IC esté bien calculado, me parece que hay
un error que estropea todo». Dos cosas:

1. La sesión de HOY entraba a medio camino: la ventana de ayer se medía contra
   una rueda sin cerrar y el IC cambiaba durante el día. Guarda sobre el código.
2. El retorno RELATIVO (instrumento − promedio) no neutraliza la beta. Si el
   score del ranking se parece a la beta, el IC diario sigue al mercado
   (positivo si sube, negativo si baja), su promedio da ~0 y su desvío es
   enorme aunque haya 50 instrumentos. Se prueba con datos sintéticos de
   propiedades conocidas, corriendo el `rank_ic.py` REAL.

    python docs/simulaciones/sim39_rank_ic_beta.py
"""
import os, random, statistics, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, "..", ".."))
sys.path.insert(0, os.path.join(RAIZ, "MIIA"))
import rank_ic  # noqa: E402

ok = falla = 0
def chequear(nombre, cond, nota=""):
    global ok, falla
    if cond: ok += 1
    else: falla += 1
    print(f"   [{'ok' if cond else 'FALLA'}] {nombre}  {nota}")

def mundo(semilla, alfa=0.0, score_es_beta=True, n=50, dias=160):
    """Retornos diarios r_i = β_i·m + α·s_i + ε. Devuelve rets {dia: {tk: r}}, betas y señal."""
    rnd = random.Random(semilla)
    tks = [f"T{i:02d}" for i in range(n)]
    beta = {t: rnd.uniform(0.5, 1.6) for t in tks}
    rets, señal = {}, {}
    for d in range(dias):
        dia = f"2026-{1 + d // 28:02d}-{1 + d % 28:02d}"
        m = rnd.gauss(0, 0.012)
        s = {t: rnd.gauss(0, 1) for t in tks}           # señal real, sin relación con β
        señal[dia] = s
        rets[dia] = {t: beta[t] * m + alfa * 0.004 * s[t] + rnd.gauss(0, 0.008) for t in tks}
    return tks, beta, rets, señal

def medir(tks, beta, rets, señal, score_es_beta):
    dias = sorted(rets)
    v_rel, v_res, pares = [], [], []
    for i in range(60, len(dias) - 1):
        hoy, fut = dias[i], dias[i + 1]
        sc = {t: (beta[t] if score_es_beta else señal[fut][t]) for t in tks}
        brutos = rets[fut]
        rel = rank_ic.retornos_relativos(brutos)
        sec = [(t, sc[t], rel[t]) for t in tks]
        v_rel.append(sec)
        ic = rank_ic.ic_de_ventana(sec)
        pares.append((ic, sum(brutos.values()) / len(brutos)))
        res = rank_ic.retornos_residuales(brutos, rank_ic.betas_previas(rets, fut))
        v_res.append([(t, sc[t], res[t]) for t in tks if t in res])
    return rank_ic.serie_ic(v_rel), rank_ic.serie_ic(v_res), rank_ic.correlacion(*map(list, zip(*pares)))

print("\n1 · un ranking que ordena por BETA (los volátiles arriba), sin habilidad")
of, neu, rho = medir(*mundo(7)[:4], score_es_beta=True)
print(f"        oficial: IC {of['rank_ic']:+.3f} σ {of['rank_ic_desvio']:.3f} · neutral a beta: IC {neu['rank_ic']:+.3f} σ {neu['rank_ic_desvio']:.3f} · ρ(IC, mercado) {rho:+.2f}")
chequear("el IC oficial de cada día sigue al mercado (ρ > 0,7)", rho > 0.7)
chequear("su desvío es mucho mayor que el del azar con 50 (1/√49 = 0,143)", of["rank_ic_desvio"] > 0.25)
chequear("el IC neutral a beta queda en el ruido (|IC| < su mínimo detectable)",
         abs(neu["rank_ic"]) < neu["rank_ic_min_detectable"])
chequear("y su desvío vuelve a ~0,14", 0.10 < neu["rank_ic_desvio"] < 0.19, f"{neu['rank_ic_desvio']:.3f}")

print("\n2 · un ranking con habilidad REAL, sin relación con la beta")
of2, neu2, rho2 = medir(*mundo(11, alfa=1.0)[:4], score_es_beta=False)
print(f"        oficial: IC {of2['rank_ic']:+.3f} · neutral a beta: IC {neu2['rank_ic']:+.3f} · ρ {rho2:+.2f}")
chequear("el IC neutral a beta la detecta (significativo)", neu2["rank_ic_significativo"] is True)
chequear("y no se aleja del oficial (no inventa ni borra habilidad)", abs(neu2["rank_ic"] - of2["rank_ic"]) < 0.08)
chequear("el IC de un ranking con habilidad no sigue al mercado (|ρ| < 0,4)", abs(rho2) < 0.4)

print("\n3 · betas sin mirar el futuro")
tks, beta, rets, _ = mundo(3)
dias = sorted(rets)
b = rank_ic.betas_previas(rets, dias[100])
bm = statistics.mean(beta.values())              # la beta es contra el PROMEDIO, cuya beta es bm
err = statistics.mean(abs(b[t] - beta[t] / bm) for t in tks)
chequear("estima las betas conocidas (error medio < 0,12 con 60 sesiones)", err < 0.12, f"{err:.3f}")
rets2 = {d: dict(r) for d, r in rets.items()}
for t in tks: rets2[dias[100]][t] = 99.0             # un valor absurdo EN la sesión medida
chequear("la sesión que se mide no entra en su propia beta", rank_ic.betas_previas(rets2, dias[100]) == b)
chequear("con menos de 15 sesiones previas no inventa una beta", rank_ic.betas_previas(rets, dias[10]) == {})

print("\n4 · guardas sobre miia_chatbot.py")
src = open(os.path.join(RAIZ, "MIIA", "miia_chatbot.py"), encoding="utf-8").read()
cuerpo = src[src.index("async def _rank_ic"):src.index("def _ventaja_vs_azar")]
chequear("el rank IC sólo usa sesiones CERRADAS (excluye la de hoy)",
         'hoy = datetime.now().strftime("%Y-%m-%d")' in cuerpo and "if d < hoy" in cuerpo)
chequear("sigue midiendo sólo el brazo nuevo (decision_modo = 'ranking')", "decision_modo = 'ranking'" in cuerpo)
chequear("publica el IC neutral a beta y la correlación con el mercado",
         '"rank_ic_beta_neutro"' in cuerpo and '"rank_ic_corr_mercado"' in cuerpo)
chequear("la beta se estima con las sesiones ANTERIORES a la ventana", "betas_previas(rets, fut[0])" in cuerpo)

print(f"\n{'PASA' if falla == 0 else 'FALLA'} — el rank IC y la beta  ({ok + falla} checks, {falla} fallas)")
sys.exit(1 if falla else 0)
