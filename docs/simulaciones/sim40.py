"""
sim40 — ¿un modelo TRANSVERSAL con atención (el corazón de un transformer) mejora
el aprendizaje de MIIA, o el cuello de botella es el dato y la señal?

NO toca producción. Lee el volcado de `precios`, arma las secciones transversales
reales (una por rueda: todos los instrumentos con precio ese día) y entrena una
ESCALERA DE CAPACIDAD, con los dos objetivos que pidió Martín:

    señal cruda (sin entrenar)  →  lineal  →  MLP por-instrumento  →  ATENCIÓN
    objetivo: binario (¿le gana al promedio?)  y  magnitud (¿cuánto?)

La ATENCIÓN es lo único que deja que el score de un instrumento dependa de los
otros de la rueda — exactamente lo que un transformer aporta sobre las redes
por-instrumento de hoy (class23/24) y sobre el LSTM por-instrumento (class44).

Se mide donde importa: rank IC en ventanas HELD-OUT (posteriores en el tiempo,
nunca vistas) con su banda, y la brecha train−test (si el modelo grande sube en
train y no en test, memoriza: el muro de pocas etiquetas independientes). Más una
prueba de OLVIDO entre regímenes (el universo pasó de 13 a 50 el 12-oct).

    python docs/simulaciones/sim40.py --extraer   # relee el volcado (1-2 min) y cachea
    python docs/simulaciones/sim40.py             # entrena y mide

Pura numpy (no hay torch en Python 3.14). El backward de la atención está
verificado por diferencias finitas al arrancar: si está mal, aborta.
"""
import sys, re
import numpy as np
from pathlib import Path

try:                                   # consola de Windows en cp1252 → UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

RAIZ    = Path(__file__).resolve().parents[2]
VOLCADO = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
DATOS   = Path(__file__).resolve().parent / "datos"
CACHE   = DATOS / "sim40_panel.npz"
CORTE   = "2026-10-12"          # ORDEN 6: el universo pasó de 13 a 50
SEED    = 7
LOOKBACKS = [1, 5, 10, 20]      # retornos a varias ventanas → features
MINHIST   = 21
if "--corto" in sys.argv:       # historia corta → incluye los 50 (aún jóvenes)
    LOOKBACKS = [1, 3, 5, 10]
    MINHIST   = 11
MIN_N     = 6
H         = 16
EPOCAS    = 300
LR        = 0.02
WD        = 3e-3                 # weight decay (regularización — clave con poco dato)

rng = np.random.default_rng(SEED)

# ─────────────────────────── 1 · extracción del panel ───────────────────────
TUPLA = re.compile(
    r"\(\d+,'([A-Za-z0-9.\-]+)','[^']*',(NULL|-?\d+\.?\d*),[^,]*,[^,]*,[^,]*,'(\d{4}-\d\d-\d\d)[^']*'\)")

def extraer():
    if not VOLCADO.exists():
        raise SystemExit(f"no está el volcado: {VOLCADO}")
    print(f"leyendo {VOLCADO.name} (1-2 min)…", flush=True)
    por_dia, n = {}, 0
    with open(VOLCADO, "r", encoding="utf8", errors="replace") as f:
        for line in f:
            if not line.startswith("INSERT INTO `precios`"):
                continue
            for m in TUPLA.finditer(line):
                tk, pr, dia = m.group(1), m.group(2), m.group(3)
                if pr == "NULL":
                    continue
                por_dia.setdefault(dia, {})[tk] = float(pr)   # orden asc → último gana (cierre)
                n += 1
    dias    = sorted(por_dia)
    tickers = sorted({t for d in por_dia.values() for t in d})
    ti = {t: i for i, t in enumerate(tickers)}
    P = np.full((len(dias), len(tickers)), np.nan)
    for di, d in enumerate(dias):
        for t, p in por_dia[d].items():
            P[di, ti[t]] = p
    DATOS.mkdir(exist_ok=True)
    np.savez_compressed(CACHE, P=P, dias=np.array(dias), tickers=np.array(tickers))
    print(f"  {n:,} precios · {len(dias)} días · {len(tickers)} instrumentos → datos/{CACHE.name}")

def cargar():
    if not CACHE.exists():
        raise SystemExit("falta el panel: corré  python docs/simulaciones/sim40.py --extraer")
    z = np.load(CACHE, allow_pickle=True)
    return z["P"], [str(d) for d in z["dias"]]

# ─────────────────────────── 2 · secciones transversales ────────────────────
def construir(P, dias):
    T, M = P.shape
    ventanas = []
    for t in range(MINHIST, T - 1):
        feats, idxs = [], []
        for j in range(M):
            if np.isnan(P[t, j]) or np.isnan(P[t + 1, j]):
                continue
            hist = P[t - MINHIST + 1: t + 1, j]
            if np.isnan(hist).any() or (hist <= 0).any():
                continue
            f, ok = [], True
            for lb in LOOKBACKS:
                if t - lb < 0:
                    ok = False; break
                base = P[t - lb, j]
                if np.isnan(base) or base == 0:
                    ok = False; break
                f.append(P[t, j] / base - 1.0)
            if not ok:
                continue
            r = hist[1:] / hist[:-1] - 1.0
            f.append(float(np.std(r)))
            feats.append(f); idxs.append(j)
        if len(idxs) < MIN_N:
            continue
        idxs = np.array(idxs)
        nr  = P[t + 1, idxs] / P[t, idxs] - 1.0
        rel = nr - nr.mean()
        if np.std(rel) < 1e-4:
            continue
        X = np.array(feats, dtype=float)
        X = (X - X.mean(0)) / (X.std(0) + 1e-8)
        ventanas.append({"X": X, "rel": rel, "dia": dias[t], "n": len(idxs)})
    return ventanas, len(LOOKBACKS) + 1

# ─────────────────────────── 3 · métrica: rank IC ───────────────────────────
def rankdata(a):
    order = a.argsort(kind="mergesort")
    ranks = np.empty(len(a), dtype=float)
    sa = a[order]; i = 0
    while i < len(a):
        j = i
        while j + 1 < len(a) and sa[j + 1] == sa[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0
        i = j + 1
    return ranks

def spearman(x, y):
    if len(x) < 3:
        return np.nan
    rx, ry = rankdata(x), rankdata(y)
    rx -= rx.mean(); ry -= ry.mean()
    d = np.sqrt((rx * rx).sum() * (ry * ry).sum())
    return float((rx * ry).sum() / d) if d > 0 else np.nan

def ic_stats(scorer, ventanas):
    ics = np.array([c for c in (spearman(scorer(v["X"]), v["rel"]) for v in ventanas)
                    if not np.isnan(c)])
    if len(ics) == 0:
        return dict(ic=np.nan, t=np.nan, mde=np.nan, nv=0)
    m = ics.mean(); N = len(ics)
    se = (ics.std(ddof=1) / np.sqrt(N)) if N > 1 else np.nan
    return dict(ic=m, t=(m / se if se else np.nan), mde=(1.96 * se if se else np.nan), nv=N)

# ─────────────────────────── 4 · modelo ─────────────────────────────────────
def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))

def objetivo(s, rel, target):
    """Devuelve (loss, ds) con ds = dLoss/ds (promedio sobre la rueda)."""
    n = len(s)
    if target == "binario":
        y = (rel > 0).astype(float)
        p = sigmoid(s)
        p = np.clip(p, 1e-9, 1 - 1e-9)
        loss = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
        return loss, (p - y) / n
    tgt = (rel - rel.mean()) / (rel.std() + 1e-9)   # magnitud estandarizada
    loss = np.mean((s - tgt) ** 2)
    return loss, 2.0 * (s - tgt) / n

class Net:
    def __init__(self, F, atn):
        self.atn = atn
        g = lambda a, b: rng.standard_normal((a, b)) / np.sqrt(a)
        self.p = {"W1": g(F, H), "b1": np.zeros(H), "w2": g(H, 1), "b2": np.zeros(1)}
        if atn:
            self.p.update({"Wq": g(H, H), "Wk": g(H, H), "Wv": g(H, H), "Wo": g(H, H)})

    def forward(self, X):
        p = self.p; c = {"X": X}
        Z1 = X @ p["W1"] + p["b1"]; H1 = np.maximum(Z1, 0.0)
        c["Z1"] = Z1; c["H1"] = H1
        if self.atn:
            Q = H1 @ p["Wq"]; K = H1 @ p["Wk"]; V = H1 @ p["Wv"]
            S = Q @ K.T / np.sqrt(H)
            S = S - S.max(1, keepdims=True)
            E = np.exp(S); A = E / E.sum(1, keepdims=True)
            Zc = A @ V
            O  = Zc @ p["Wo"] + H1
            Hf = np.maximum(O, 0.0)
            c.update(Q=Q, K=K, V=V, A=A, Zc=Zc, O=O, Hf=Hf)
        else:
            Hf = H1; c["Hf"] = Hf; c["O"] = None
        s = (Hf @ p["w2"] + p["b2"]).ravel()
        return s, c

    def backward(self, c, ds):
        p = self.p; g = {k: np.zeros_like(v) for k, v in p.items()}
        ds = ds.reshape(-1, 1)
        g["w2"] += c["Hf"].T @ ds
        g["b2"] += ds.sum(0)
        dHf = ds @ p["w2"].T
        if self.atn:
            dO  = dHf * (c["O"] > 0)
            g["Wo"] += c["Zc"].T @ dO
            dZc = dO @ p["Wo"].T
            dA  = dZc @ c["V"].T
            dV  = c["A"].T @ dZc
            dS  = c["A"] * (dA - (dA * c["A"]).sum(1, keepdims=True))   # softmax por fila
            dS /= np.sqrt(H)
            dQ  = dS @ c["K"]
            dK  = dS.T @ c["Q"]
            g["Wq"] += c["H1"].T @ dQ
            g["Wk"] += c["H1"].T @ dK
            g["Wv"] += c["H1"].T @ dV
            dH1 = dO + dQ @ p["Wq"].T + dK @ p["Wk"].T + dV @ p["Wv"].T   # dO = vía residual
        else:
            dH1 = dHf
        dZ1 = dH1 * (c["Z1"] > 0)
        g["W1"] += c["X"].T @ dZ1
        g["b1"] += dZ1.sum(0)
        return g

class Adam:
    def __init__(self, p, lr, wd):
        self.lr, self.wd = lr, wd
        self.m = {k: np.zeros_like(v) for k, v in p.items()}
        self.v = {k: np.zeros_like(v) for k, v in p.items()}
        self.t = 0
    def step(self, p, g):
        self.t += 1
        for k in p:
            gg = g[k] + self.wd * p[k]
            self.m[k] = 0.9 * self.m[k] + 0.1 * gg
            self.v[k] = 0.999 * self.v[k] + 0.001 * gg * gg
            mh = self.m[k] / (1 - 0.9 ** self.t)
            vh = self.v[k] / (1 - 0.999 ** self.t)
            p[k] -= self.lr * mh / (np.sqrt(vh) + 1e-8)

def fit(net, opt, ventanas, target, epocas):
    for _ in range(epocas):
        acc = {k: np.zeros_like(v) for k, v in net.p.items()}
        for v in ventanas:
            s, c = net.forward(v["X"])
            _, ds = objetivo(s, v["rel"], target)
            g = net.backward(c, ds)
            for k in acc:
                acc[k] += g[k]
        inv = 1.0 / len(ventanas)
        for k in acc:
            acc[k] *= inv
        opt.step(net.p, acc)
    return net

def entrenar(ventanas, F, atn, target, epocas=EPOCAS):
    net = Net(F, atn)
    fit(net, Adam(net.p, LR, WD), ventanas, target, epocas)
    return net

# ─────────────────────────── 5 · verificación de gradiente ──────────────────
def grad_check():
    for atn in (False, True):
        net = Net(5, atn)
        X = rng.standard_normal((5, 5)); rel = rng.standard_normal(5)
        s, c = net.forward(X)
        _, ds = objetivo(s, rel, "magnitud")
        g = net.backward(c, ds)
        peor = 0.0
        for k in net.p:
            flat = net.p[k].ravel(); gflat = g[k].ravel()
            for i in range(min(len(flat), 6)):
                o = flat[i]; eps = 1e-5
                flat[i] = o + eps; Lp = objetivo(net.forward(X)[0], rel, "magnitud")[0]
                flat[i] = o - eps; Lm = objetivo(net.forward(X)[0], rel, "magnitud")[0]
                flat[i] = o
                num = (Lp - Lm) / (2 * eps)
                den = max(1e-8, abs(num) + abs(gflat[i]))
                peor = max(peor, abs(num - gflat[i]) / den)
        etq = "ATENCIÓN" if atn else "MLP"
        if peor > 1e-4:
            raise SystemExit(f"❌ backward {etq} MAL (err rel {peor:.2e}) — no confiar en los resultados")
        print(f"  grad-check {etq:9} OK (err rel {peor:.1e})")

# ─────────────────────────── 6 · main ───────────────────────────────────────
def fila(nombre, tr, te):
    sig = "⚠️ sobreajusta" if (tr["ic"] - te["ic"]) > 0.08 else ""
    dist = "←fuera del ruido" if (not np.isnan(te["ic"]) and abs(te["ic"]) > te["mde"]) else "dentro del ruido"
    return (f"  {nombre:24} test IC {te['ic']:+.3f} (t={te['t']:+.2f}, ±{te['mde']:.3f}) "
            f"{dist:16}  train {tr['ic']:+.3f}  {sig}")

def main():
    if "--extraer" in sys.argv:
        extraer()
    P, dias = cargar()
    vent, F = construir(P, dias)
    print(f"\nPanel: {len(vent)} ruedas con sección transversal "
          f"(media {np.mean([v['n'] for v in vent]):.0f} instrumentos/rueda), {F} features\n")
    print("Verificación de gradientes (si falla, aborta):")
    grad_check()

    k = int(len(vent) * 0.65)
    tr, te = vent[:k], vent[k:]
    print(f"\nSplit temporal: train {len(tr)} ruedas ({tr[0]['dia']}→{tr[-1]['dia']})  |  "
          f"test {len(te)} ruedas ({te[0]['dia']}→{te[-1]['dia']})")

    for target in ("binario", "magnitud"):
        print(f"\n═══ objetivo: {target.upper()} "
              f"({'¿le gana al promedio? 1/0' if target=='binario' else 'cuánto le gana'}) ═══")
        # señal cruda (mejor feature sin entrenar)
        mejor, mejor_te = None, None
        for fi in range(F):
            te_ic = ic_stats(lambda X, fi=fi: X[:, fi], te)
            if mejor_te is None or abs(te_ic["ic"]) > abs(mejor_te["ic"]):
                mejor, mejor_te = fi, te_ic
        tr_ic = ic_stats(lambda X, fi=mejor: X[:, fi], tr)
        print(fila(f"señal cruda (feat {mejor})", tr_ic, mejor_te))
        # lineal (ridge cerrado)
        Xp = np.vstack([v["X"] for v in tr])
        yp = np.hstack([(v["rel"] > 0) * 2.0 - 1.0 if target == "binario"
                        else (v["rel"] - v["rel"].mean()) / (v["rel"].std() + 1e-9) for v in tr])
        w = np.linalg.solve(Xp.T @ Xp + 1.0 * np.eye(F), Xp.T @ yp)
        lin = lambda X: X @ w
        print(fila("lineal", ic_stats(lin, tr), ic_stats(lin, te)))
        # MLP y ATENCIÓN
        for atn, nom in ((False, "MLP (por-instrumento)"), (True, "ATENCIÓN (transformer)")):
            net = entrenar(tr, F, atn, target)
            sc = lambda X, net=net: net.forward(X)[0]
            print(fila(nom, ic_stats(sc, tr), ic_stats(sc, te)))

    # ── olvido entre regímenes (universo 13 → 50 el 12-oct) ──
    A = [v for v in vent if v["dia"] < CORTE]
    B = [v for v in vent if v["dia"] >= CORTE]
    print(f"\n═══ OLVIDO entre regímenes  (A=pre-corte 13 instr: {len(A)} ruedas · "
          f"B=post-corte 50 instr: {len(B)} ruedas) ═══")
    if len(A) > 20 and len(B) >= 8:
        ka = int(len(A) * 0.8); Atr, Ate = A[:ka], A[ka:]
        net = entrenar(Atr, F, True, "binario")
        sc = lambda X, net=net: net.forward(X)[0]
        icA1, icB1 = ic_stats(sc, Ate)["ic"], ic_stats(sc, B)["ic"]
        fit(net, Adam(net.p, LR, WD), B, "binario", EPOCAS)   # sigue aprendiendo B
        icA2, icB2 = ic_stats(sc, Ate)["ic"], ic_stats(sc, B)["ic"]
        print(f"  atención entrenada en A      → IC(A held-out) {icA1:+.3f}   IC(B) {icB1:+.3f}")
        print(f"  después de aprender B también → IC(A held-out) {icA2:+.3f}   IC(B) {icB2:+.3f}")
        print(f"  OLVIDO de A = {icA1 - icA2:+.3f}   (positivo = se olvidó lo viejo al aprender lo nuevo)")
    else:
        print("  (pocas ruedas en algún régimen para medir olvido con sentido)")

    print("\nLectura: si ATENCIÓN no supera a MLP en TEST IC, la atención no agrega — "
          "el cuello es el dato/la señal, no la arquitectura. Si el train IC es alto y el "
          "test IC ~0, memoriza (el muro de pocas etiquetas).")

if __name__ == "__main__":
    main()
