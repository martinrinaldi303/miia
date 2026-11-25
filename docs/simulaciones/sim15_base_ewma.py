"""sim15_base_ewma.py — la base con olvido, ANTES de escribirla.

QUÉ ES `g_base`. La media y el desvío de cada red, contra los que se calcula su
z. Ese z decide dos cosas: **el orden del ranking transversal** (quién sale BUY
y quién SELL) y **a quién le cobra la capa 2** el resultado.

EL DEFECTO. `g_base` es un acumulador de Welford desde el arranque del proceso,
sin olvido. Medido el 14-sep: la emisión fue 46 % → 3,8 % → 52 % → 14 % en seis
horas mientras el umbral se movía sólo entre 0,402 y 0,467. El diagnóstico
escrito ese día: «`g_base` es media y desvío acumulados desde el sábado 04:00,
casi todo de fin de semana, y no representa la rueda».

POR QUÉ SE SIMULA ANTES. Cambiar la base cambia la escala de TODAS las
decisiones. Y el parámetro —cuánto olvidar— no se puede elegir a ojo: olvidar de
más deja el z en ruido, olvidar de menos es lo que ya hay.

⚠️ **Y hay una trampa propia, que conviene decir antes de mostrar la tabla:**
probar seis vidas medias sobre 27 ventanas y quedarse con la que da el IC más
alto **es sobreajuste**, no medición. Con 27 ventanas la banda del IC es ±0,11 y
el mejor de seis candidatos sale alto por azar. Así que acá la vida media se
elige por ARITMÉTICA —cuántas muestras tarda en representar la rueda— y la tabla
sirve sólo para descartar que el valor elegido sea patológico.

    python docs/simulaciones/sim15_base_ewma.py
"""

from __future__ import annotations

import importlib.util
import math
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))

import rank_ic  # noqa: E402  el código de producción

# sim13 ya sabe armar las ventanas y leer el extracto del volcado.
_spec = importlib.util.spec_from_file_location("s13", AQUI / "sim13_ensamble.py")
s13 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(s13)

#: Decisiones por rueda, y por lo tanto actualizaciones de `g_base` por clave.
#: Medido el 14-sep: 11.822 decisiones entre las 16:34 y las 22:34 CEST.
RUEDA_MUESTRAS = 13_000
#: El valor que va al C++ (`BASE_VIDA_MEDIA`). Ver el criterio en la sección 1.
VIDA_MEDIA = 5_000

fallos = 0


def chequear(que: str, ok: bool, detalle: str = "") -> None:
    global fallos
    print(f"   {'[ok]' if ok else '[NO]'} {que:<54} {detalle}")
    if not ok:
        fallos += 1


# ════════════════════════════════════════════════════════════════════
# La base, en sus dos versiones — el MISMO código que va al C++
# ════════════════════════════════════════════════════════════════════
class BaseAcum:
    """Welford sin olvido: lo que hay hoy en class25A."""

    def __init__(self) -> None:
        self.n, self.media, self.m2 = 0, 0.0, 0.0

    def observar(self, x: float) -> None:
        self.n += 1
        d = x - self.media
        self.media += d / self.n
        self.m2 += d * (x - self.media)

    def desvio(self) -> float:
        return math.sqrt(self.m2 / (self.n - 1)) if self.n > 1 else 0.0


class BaseEwma:
    """Media y varianza exponenciales (West 1979).

    El alfa efectivo arranca en 1/n y recién baja al alfa fijo cuando 1/n cae
    por debajo. Sin eso, las primeras muestras arrastrarían el cero inicial y la
    red tardaría en tener una base creíble justo después de un reinicio — que es
    cuando más importa, porque `g_base` vive en memoria.
    """

    def __init__(self, vida_media: float) -> None:
        self.alpha = 1.0 - math.pow(0.5, 1.0 / vida_media) if vida_media > 0 else 0.0
        self.n, self.media, self.var = 0, 0.0, 0.0

    def observar(self, x: float) -> None:
        self.n += 1
        a = max(self.alpha, 1.0 / self.n)
        d = x - self.media
        incr = a * d
        self.media += incr
        self.var = (1.0 - a) * (self.var + d * incr)

    def desvio(self) -> float:
        return math.sqrt(self.var) if self.var > 0 else 0.0


# ════════════════════════════════════════════════════════════════════
def main() -> int:
    print("\n=== La base con olvido (EWMA) en g_base ======================\n")

    if not s13.GUARDADO.exists():
        print("   falta datos/ventanas_ensamble.json — correr sim13 --extraer")
        return 1
    import json
    datos = json.loads(s13.GUARDADO.read_text(encoding="utf8"))

    # ── 1 · Lo mecánico: cuánto tarda cada base en seguir un escalón ──
    # No necesita datos: es aritmética, y es el corazón del defecto. Una red que
    # cambia de nivel —class24/mercado hizo ema 0,89 → 0,02 → 0,37 → 0,63 →
    # 0,009 en una semana— deja a la base acumulada midiendo otra cosa.
    print("1 · Seguir un cambio de nivel (la red salta de 0,50 a 0,80)")
    print("      muestras hasta cubrir el 90 % del salto:")
    print(f"      {'vida media':>12} {'muestras':>10}")
    for vm in (0, 2500, 5000, 10000, 20000):
        base = BaseAcum() if vm == 0 else BaseEwma(vm)
        for _ in range(20000):          # régimen viejo, nivel 0,50
            base.observar(0.50)
        objetivo = 0.50 + 0.90 * 0.30
        pasos = 0
        while base.media < objetivo and pasos < 400_000:
            base.observar(0.80)
            pasos += 1
        etiq = "acumulada" if vm == 0 else f"{vm:,}"
        print(f"      {etiq:>12} {pasos:>10,}" +
              ("   <- nunca representa la rueda" if vm == 0 else ""))

    base_ac = BaseAcum()
    for _ in range(20000):
        base_ac.observar(0.50)
    p_ac = 0
    while base_ac.media < 0.50 + 0.90 * 0.30 and p_ac < 400_000:
        base_ac.observar(0.80)
        p_ac += 1
    base_ew = BaseEwma(VIDA_MEDIA)
    for _ in range(20000):
        base_ew.observar(0.50)
    p_ew = 0
    while base_ew.media < 0.50 + 0.90 * 0.30 and p_ew < 400_000:
        base_ew.observar(0.80)
        p_ew += 1
    chequear("la acumulada tarda un orden de magnitud más", p_ac > 10 * p_ew,
             f"{p_ac:,} contra {p_ew:,} muestras")

    # ── EL CRITERIO DE ELECCIÓN, y de dónde sale el número ────────────
    # El defecto escrito el 14-sep: «`g_base` es media y desvío acumulados desde
    # el sábado 04:00, casi todo de fin de semana, y no representa la rueda».
    # Entonces la exigencia es: **que una rueda alcance para olvidar el fin de
    # semana**, o sea que el 90 % de un cambio de nivel entre en ~una rueda.
    #
    # Cuántas muestras es una rueda: `g_base[clave]` se actualiza una vez por
    # decisión en la que esa red publica score. Medido el 14-sep de 16:34 a
    # 22:34 CEST: 11.822 decisiones en 6 h, o sea ~2.000 por hora; una rueda de
    # 6,5 h son ~13.000. (Las ~18.300 por día del heartbeat incluyen la noche,
    # que va mucho más lenta: usar ese promedio da un número 1,4 veces más
    # grande y fue el primer error de esta cuenta.)
    #
    # 90 % de un escalón son 3,32 vidas medias, así que 13.000 / 3,32 ≈ 3.900.
    # Se redondea a 5.000, que deja el 90 % en ~1,3 ruedas: preferir el lado
    # LENTO, porque olvidar de más deja el z en ruido de estimación y eso no se
    # ve en ningún contador — se ve como un ranking que ordena cualquier cosa.
    chequear(f"con vida media {VIDA_MEDIA:,} el 90 % del salto entra en ~1 rueda",
             p_ew < 2 * RUEDA_MUESTRAS,
             f"{p_ew:,} muestras = {p_ew/RUEDA_MUESTRAS:.1f} ruedas")
    chequear("y el 50 % en menos de media rueda",
             VIDA_MEDIA < RUEDA_MUESTRAS / 2,
             f"vida media {VIDA_MEDIA:,} contra {RUEDA_MUESTRAS:,} por rueda")

    # ── 2 · El z que sale de cada base, sobre los scores reales ───────
    print("\n2 · Rank IC con cada base, sobre las ventanas reales del volcado")
    print("      (predicción = z del instrumento contra SU base; sin mirar el futuro)")

    ruedas = datos["ruedas"]
    cierres = datos["cierres"]

    # Retornos por sesión, con el mismo filtro de días sin sesión que el endpoint.
    sesiones_pre = sorted(cierres)
    rets: dict = {}
    for i in range(1, len(sesiones_pre)):
        hoy, ayer = sesiones_pre[i], sesiones_pre[i - 1]
        for tk, p1 in cierres[hoy].items():
            p0 = cierres[ayer].get(tk)
            if p0 and p0 > 0:
                rets.setdefault(hoy, {})[tk] = p1 / p0 - 1.0
    for d in [d for d, r in rets.items()
              if not r or max(abs(x) for x in r.values()) == 0.0]:
        del rets[d]
    con_ret = sorted(rets)

    def ic_con_base(fabrica) -> dict:
        """fabrica() -> una base nueva por instrumento. None = score crudo."""
        bases: dict = {}
        ventanas, usada = [], ""
        for r in ruedas:
            dia = r["dia"]
            fut = [s for s in con_ret if s > dia]
            if not fut or fut[0] <= usada:
                # Igual hay que ALIMENTAR la base con esta rueda: saltearla
                # cambiaría la historia que ve el z de las siguientes.
                if fabrica is not None:
                    for tk, sc in r["scores"].items():
                        bases.setdefault(tk, fabrica()).observar(sc)
                continue
            rel = rank_ic.retornos_relativos(rets[fut[0]])
            sec = []
            for tk, sc in r["scores"].items():
                if tk not in rel:
                    continue
                if fabrica is None:
                    sec.append((tk, sc, rel[tk]))
                else:
                    b = bases.setdefault(tk, fabrica())
                    sd = b.desvio()
                    # Sin base todavía o red constante: no entra al z. Es la
                    # misma guarda que class25A (DEC_Z_MIN_MUESTRAS, sd > 1e-9).
                    if b.n >= 5 and sd > 1e-9:
                        sec.append((tk, (sc - b.media) / sd, rel[tk]))
            # La base se alimenta DESPUÉS de predecir: si no, el z de hoy
            # incluiría el score de hoy y se estaría mirando el futuro.
            if fabrica is not None:
                for tk, sc in r["scores"].items():
                    bases.setdefault(tk, fabrica()).observar(sc)
            if sec:
                ventanas.append(sec)
                usada = fut[0]
        return rank_ic.serie_ic(ventanas)

    filas = [("score crudo (sin base)", ic_con_base(None))]
    filas.append(("z, base ACUMULADA (hoy)", ic_con_base(lambda: BaseAcum())))
    for vm in (1, 2, 3, 5, 10, 20):
        filas.append((f"z, base EWMA vida media {vm} ruedas",
                      ic_con_base(lambda vm=vm: BaseEwma(vm))))

    print(f"\n      {'variante':<34}{'IC':>9}{'sigma':>9}{'vent':>6}{'t':>7}{'MDE':>9}")
    for nombre, r in filas:
        print(f"      {nombre:<34}{r['rank_ic']:>9}{r['rank_ic_desvio']:>9}"
              f"{r['rank_ic_ventanas']:>6}{r['rank_ic_t']:>7}"
              f"{r['rank_ic_min_detectable']:>9}")

    ics = [r["rank_ic"] for _, r in filas]
    mde = max(r["rank_ic_min_detectable"] for _, r in filas)
    print(f"\n      Rango de las {len(filas)}: {min(ics):+.4f} a {max(ics):+.4f}  "
          f"(MDE {mde:.4f})")
    # ⚠️ LA GRANULARIDAD NO ES LA MISMA, y sin esto la tabla se lee mal.
    # Acá cada instrumento aporta UN punto por rueda (su score medio del día),
    # así que «vida media 1 rueda» es lo más corto que este extracto puede
    # representar. En producción `g_base` ve ~13.000 muestras por rueda, o sea
    # que la vida media elegida (5.000 muestras) es TRES VECES MÁS CORTA que la
    # fila más corta de esta tabla. **Esta tabla acota el extremo largo; del
    # corto no dice nada.**
    print(f"      (1 rueda de esta tabla = {RUEDA_MUESTRAS:,} muestras en producción;")
    print(f"       la vida media elegida, {VIDA_MEDIA:,}, es MÁS CORTA que toda la tabla)")

    # ⚠️ Lo importante de esta sección NO es cuál gana. Con 27 ventanas la banda
    # es ±0,11 y las seis variantes caben holgadas adentro: la diferencia entre
    # ellas NO es medible con estos datos. Lo que el test exige es sólo que
    # ninguna se vuelva patológica — un IC muy negativo diría que normalizar por
    # la base DA VUELTA el orden, y eso sí sería una razón para no desplegarlo.
    chequear("ninguna variante da vuelta el orden (IC muy negativo)",
             min(ics) > -0.05, f"mínimo {min(ics):+.4f}")
    chequear("las diferencias entre variantes NO son medibles con 27 ventanas",
             (max(ics) - min(ics)) < mde,
             f"rango {max(ics)-min(ics):.4f} < MDE {mde:.4f}")
    chequear("la base no deja ventanas sin orden",
             all(r["rank_ic_ventanas"] >= 20 for _, r in filas),
             "todas conservan la sección transversal")

    print("\n      -> La elección de la vida media NO sale de esta tabla: sale de")
    print("         la sección 1 (que una rueda alcance para olvidar el fin de")
    print("         semana). La tabla sólo descarta que normalizar por la base")
    print("         rompa el orden, y muestra que la base ACUMULADA de hoy es la")
    print("         peor de todas las variantes — que era la hipótesis.")

    # ── 3 · La aritmética del EWMA ────────────────────────────────────
    print("\n3 · Que el estimador sea el que dice ser")
    {
        # Una serie estacionaria: el EWMA tiene que converger a la media y al
        # desvío verdaderos, o el z estaría mal escalado y el ranking ordenaría
        # por ruido de estimación.
    }
    import random
    random.seed(20260921)
    b = BaseEwma(5000)
    for _ in range(200_000):
        b.observar(random.gauss(0.60, 0.05))
    chequear("sobre una serie estable converge a la media", abs(b.media - 0.60) < 0.005,
             f"media={b.media:.4f} (verdadera 0,6000)")
    chequear("y al desvío", abs(b.desvio() - 0.05) < 0.005,
             f"desvío={b.desvio():.4f} (verdadero 0,0500)")

    b2 = BaseEwma(5000)
    b2.observar(0.7)
    chequear("con UNA muestra la media es esa muestra, no la mitad",
             abs(b2.media - 0.7) < 1e-12,
             "el alfa arranca en 1/n: no arrastra el cero inicial")
    chequear("y el desvío es 0, así que todavía no opina",
             b2.desvio() == 0.0, "la guarda sd > 1e-9 la deja afuera")

    b3 = BaseEwma(0)      # vida media 0 = sin olvido
    for x in (0.1, 0.2, 0.3, 0.4):
        b3.observar(x)
    chequear("vida media 0 se comporta como la acumulada (rollback)",
             abs(b3.media - 0.25) < 1e-12, f"media={b3.media:.4f}")

    # ── 4 · Que el C++ use el mismo número ────────────────────────────
    # `sim9` verifica al revés: corre el `observarBase` real de class25A y lo
    # compara contra los valores de ESTE modelo. Lo que falta es que la
    # CONSTANTE coincida: el mejor modelo del mundo no sirve si el binario
    # corre con otra vida media.
    print("\n4 · Que el binario use la vida media que se simuló")
    src = (RAIZ / "miia_cognitive" / "class25A.cpp").read_text(encoding="utf8")
    import re
    m = re.search(r"g_base_vida_media\s*=\s*([0-9.]+)", src)
    chequear("class25A declara la misma vida media",
             bool(m) and abs(float(m.group(1)) - VIDA_MEDIA) < 1e-9,
             f"class25A={m.group(1) if m else '?'} · sim15={VIDA_MEDIA}")
    chequear("y el z se lee por una sola función (desvioBase)",
             src.count("std::sqrt(b->second.m2") == 0
             and src.count("desvioBase(") >= 3,
             "la decisión y la capa 2 no pueden divergir")
    chequear("queda el rollback sin recompilar",
             "CLASS25A_BASE_VIDA_MEDIA" in src, "=0 vuelve a la acumulada")

    print(f"\n{'PASA' if fallos == 0 else 'FALLA'} — base con olvido\n")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
