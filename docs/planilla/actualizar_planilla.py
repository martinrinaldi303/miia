# Agrega mediciones a redes_neuronales_de_miia.xlsx sin perder los gráficos.
#
# Por qué existe: openpyxl NO lee gráficos. Abrir el Excel con load_workbook y
# guardarlo borra los cinco gráficos. Este script lee las filas que ya hay
# (incluidas las que Martín cargue a mano), les suma las nuevas y RECONSTRUYE el
# archivo entero: tablas, fórmulas y gráficos.
#
# Uso:
#   python docs/planilla/actualizar_planilla.py nuevas.json
#   python docs/planilla/actualizar_planilla.py nuevas.json --destino otra.xlsx
#
# nuevas.json:
#   {"Pesos": [["2026-09-12 23:48", mercado, cluster, impacto, portfolio, pelado,
#               umbral, emision, z, "nota"]],
#    "Tesis": [["2026-09-12 23:48", n_efectivo, ruido, base_rate, acierto, ventaja,
#               "no", verificadas, dias, pendientes, "nota"]],
#    "Redes": [["2026-09-12 23:51", ema_mer, ema_por, ema_imp, ema_clu,
#               seen_mer, sup_mer, seen_por, sup_por, seen_imp, sup_imp,
#               seen_clu, sup_clu, "nota"]],
#    "Recursos": [["2026-09-12 23:51", ram, disco, load, mysqld_mb, class44_mb, class30_mb,
#                  chatbot_mb, uptime_dias, "nota"]],
#    "Corte": [["2026-10-13 16:30", rank_ic, ic_min_detectable, ventanas, desvio,
#               "si"/"no", modo, pct_buy, rep23_ej, rep23_rep, rep24_ej, rep24_rep,
#               cola_class30, swap_mb, swap_cache_mb, "nota"]]}
# La conversión automática desde un chequeo la hace docs/planilla/leer_chequeo.py.
# Sin las columnas calculadas (etiqueta, suma control, ruido -, referencia 0,5):
# esas las arma el script. Porcentajes como fracción (0.25). null = sin dato.
# Una fila con la misma fecha y hora que otra ya cargada se ignora, así que
# correrlo dos veces no duplica nada.
import json
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.axis import ChartLines
from openpyxl.chart.marker import Marker
from openpyxl.chart.text import RichText
from openpyxl.drawing.text import CharacterProperties, Paragraph, ParagraphProperties, RichTextProperties
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

DESTINO = Path(r"C:\Users\martin\Desktop\redes_neuronales_de_miia.xlsx")

F_TIT = Font(name="Arial", size=14, bold=True)
F_HDR = Font(name="Arial", size=10, bold=True, color="FFFFFF")
F_TXT = Font(name="Arial", size=10)
F_NOTA = Font(name="Arial", size=9, italic=True, color="555555")
FILL_HDR = PatternFill("solid", fgColor="1F3864")
HOJA_GRAFICOS = "graficos"
FMT_FECHA = "dd/mm/yyyy hh:mm"
FMT_P4, FMT_P3, FMT_PCT, FMT_INT, FMT_PP = "0.0000", "0.000", "0.0%", "#,##0", "0.0"
ETIQUETA = '=IF(A{i}="","",TEXT(A{i},"dd-mmm hh:mm"))'

# Definición de cada hoja: encabezados, anchos, formatos, columnas calculadas
# (índice 1-based → plantilla de fórmula) y columnas que entran desde el JSON.
HOJAS = {
    "Pesos": dict(
        titulo="MIIA - pesos del ensemble por fuente",
        tabla="TablaPesos",
        headers=["fecha y hora", "etiqueta", "mercado", "cluster", "impacto", "portfolio",
                 "modulo pelado", "suma control", "umbral", "emision", "decisiones por z", "nota"],
        anchos=[17, 14, 10, 10, 10, 10, 13, 12, 9, 10, 15, 60],
        fmts=[FMT_FECHA, None, FMT_P4, FMT_P4, FMT_P4, FMT_P4, FMT_P4, FMT_P4, FMT_P3, FMT_PCT, FMT_PCT, None],
        calc={2: ETIQUETA, 8: '=IF(COUNT(C{i}:G{i})=0,"",SUM(C{i}:G{i}))'},
        entrada=[1, 3, 4, 5, 6, 7, 9, 10, 11, 12],
        nota="Fuente: heartbeat de class25A (2 decimales) o state/class25a_pesos.json sumado por familia "
             "(4 decimales). Las cinco familias tienen que sumar 1,0000.",
    ),
    "Tesis": dict(
        titulo="MIIA - la tesis (leer: n_efectivo, ruido, significativa, ventaja)",
        tabla="TablaTesis",
        headers=["fecha y hora", "etiqueta", "n_efectivo", "ruido +", "ruido -", "base rate", "acierto",
                 "ventaja (pp)", "significativa", "verificadas", "dias", "pendientes BUY/SELL", "nota"],
        anchos=[17, 14, 11, 10, 10, 10, 10, 12, 13, 12, 7, 18, 52],
        fmts=[FMT_FECHA, None, FMT_INT, FMT_PP, FMT_PP, FMT_PCT, FMT_PCT, FMT_PP, None, FMT_INT, FMT_INT, FMT_INT, None],
        calc={2: ETIQUETA, 5: '=IF(D{i}="","",-D{i})'},
        entrada=[1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13],
        nota="Fuente: sección 7 de miia_check.sh. 'ruido' es edge_min_detectable = 1,96 x raíz(p(1-p)/n): la "
             "ventaja mínima que se distingue del azar con esa cantidad de datos. Mientras la ventaja quede "
             "adentro de la banda, la lectura es 'sin ventaja demostrable'.",
    ),
    "Redes": dict(
        titulo="MIIA - redes de class24 (ema de inferencia)",
        tabla="TablaRedes",
        headers=["fecha y hora", "etiqueta", "ema mercado", "ema portfolio|32", "ema impacto|12",
                 "ema cluster|12", "referencia 0,5", "seen mercado", "sup mercado", "seen portfolio",
                 "sup portfolio", "seen impacto", "sup impacto", "seen cluster", "sup cluster", "nota"],
        anchos=[17, 14, 15, 16, 15, 15, 14, 13, 12, 14, 13, 13, 12, 13, 12, 48],
        fmts=[FMT_FECHA, None, FMT_P4, FMT_P4, FMT_P4, FMT_P4, FMT_P3] + [FMT_INT] * 8 + [None],
        calc={2: ETIQUETA, 7: '=IF(COUNT(C{i}:F{i})=0,"",0.5)'},
        entrada=[1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        nota="Fuente: grep -ah \"ema_inf=\" en los logs de class24. La ema mide SESGO, no habilidad: una red "
             "bien entrenada se acerca a 0,5 con dispersión alrededor. Si 'sup' no crece, no está llegando "
             "feedback supervisado. 'mercado' es la red mercado|64 hasta el corte del 12-oct y mercado|22 "
             "después: es otra red, que nace de cero ese día.",
    ),
    # Agregada el 5-oct-2026 para evaluar el corte día por día. Antes del 12-oct
    # sólo se llenan las columnas de memoria; las del rank IC y el repaso nacen
    # con el corte.
    "Corte": dict(
        titulo="MIIA - después del corte del 12-oct (rank IC, repaso, memoria)",
        tabla="TablaCorte",
        headers=["fecha y hora", "etiqueta", "rank IC", "IC min. detectable +", "IC min. detectable -",
                 "ventanas IC", "desvio IC", "significativo", "modo", "% BUY (muestra 5 min)",
                 "repaso c23 ejemplos", "repaso c23 repasados", "repaso c24 ejemplos",
                 "repaso c24 repasados", "class30 cola", "swap usado MB", "swap en cache MB", "nota"],
        anchos=[17, 14, 10, 12, 12, 10, 10, 12, 10, 12, 12, 12, 12, 12, 12, 11, 11, 60],
        fmts=[FMT_FECHA, None, "0.0000", "0.0000", "0.0000", FMT_INT, "0.0000", None, None, FMT_PCT,
              FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_INT, FMT_INT, None],
        calc={2: ETIQUETA, 5: '=IF(D{i}="","",-D{i})'},
        entrada=[1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        nota="Fuente: lectura_diaria.sh (el chequeo de las 15:30 de Nueva York más los extras). El rank IC se "
             "lee SIEMPRE contra su banda: mientras quede adentro, no hay ventaja demostrable. '% BUY' es de "
             "los 5 minutos de muestra, no del día: con el ranking tiene que rondar 50 %. La cola de class30 "
             "tiene que quedar en 200 o menos después del corte; antes crecía ~15.000 por rueda.",
    ),
    "Recursos": dict(
        titulo="MIIA - memoria del server (la VPS tiene 11,7 GB)",
        tabla="TablaRecursos",
        headers=["fecha y hora", "etiqueta", "RAM %", "RAM GB", "alarma 85%", "disco %", "load 1m",
                 "mysqld MB", "class44 LSTM MB", "class30 MB", "chatbot MB", "uptime MIIA (dias)", "nota"],
        anchos=[17, 14, 9, 9, 11, 9, 9, 12, 16, 12, 12, 18, 52],
        fmts=[FMT_FECHA, None, FMT_PCT, "0.00", FMT_PCT, FMT_PCT, "0.00",
              FMT_INT, FMT_INT, FMT_INT, FMT_INT, "0.0", None],
        calc={2: ETIQUETA, 4: '=IF(C{i}="","",ROUND(C{i}*11.7,2))', 5: '=IF(C{i}="","",0.85)'},
        entrada=[1, 3, 6, 7, 8, 9, 10, 11, 12, 13],
        nota="Fuente: sección 1 de miia_check.sh (RAM, disco, load) y, para el desglose por proceso, "
             "ps -eo rss=,etimes=,args= --sort=-rss | head -12 (el RSS viene en KB: dividir por 1024). "
             "La RAM del chequeo NO cuenta caché: es memoria de verdad en uso. El chequeo alarma a los 85%. "
             "Lo que importa no es el valor de un día sino la PENDIENTE: medida entre el 10 y el 20-sep da "
             "+1,35 a +1,56 puntos por día (160-190 MB). Un reinicio completo la baja de golpe (10-sep: "
             "50% -> 42%), así que la parte que se recupera reiniciando es de los procesos, no del sistema.",
    ),
}

GUIA = [
    ("Regla general", "Escribí la fecha en la primera celda vacía debajo de la última fila: la tabla se estira "
                      "sola y las columnas con fórmula (etiqueta, suma control, ruido -, referencia 0,5) se "
                      "completan solas. Esas no se escriben."),
    ("Formato", "Fecha: 12/09/2026 04:05, hora del server (CEST). Decimales con coma. En 'emision', 'acierto' y "
                "'base rate' escribí 25% o 0,25; si escribís 25 a secas Excel lo toma como 2500%."),
    ("Desde el asistente", "Para cargar por código: python docs/planilla/actualizar_planilla.py nuevas.json. Reconstruye "
                     "el archivo conservando todas las filas; abrir y guardar con openpyxl borra los gráficos."),
    ("", ""),
    ("Hoja Pesos", "ssh root@TU_SERVER 'grep -a \"voto por módulo\" /opt/miia/operador/aprendizaje/logs/class25A.log | tail -1'"),
    ("", "Con 4 decimales: ssh root@TU_SERVER 'cat /opt/miia/operador/aprendizaje/state/class25a_pesos.json' "
         "y sumar las claves de cada familia."),
    ("Hoja Tesis", "ssh root@TU_SERVER 'bash /root/miia_check.sh' > chequeo.txt  (sección 7; pendientes en la 9)"),
    ("Hoja Redes", "ssh root@TU_SERVER 'grep -ah \"ema_inf=\" /opt/miia/operador/aprendizaje/logs/class24* | tail -4'"),
    ("Hoja Recursos", "RAM, disco y load salen de la sección 1 del mismo chequeo. Para el desglose por proceso: "
                      "ssh root@TU_SERVER \"free -m; swapon --show; ps -eo rss=,etimes=,args= --sort=-rss | head -12\""),
    ("", "El RSS viene en KB (dividir por 1024) y etimes en segundos (dividir por 86400 para días). Cargar el "
         "mismo día que la lectura de la tesis: lo que se mide es la pendiente, y para eso las fechas tienen "
         "que estar parejas."),
    ("", ""),
    ("Lectura diaria", "Desde el 5-oct-2026 el server guarda un chequeo por día de rueda (15:30 de Nueva York) en "
                       "/root/lecturas/. Para cargarlas todas: bash docs/planilla/traer_lecturas.sh — baja las "
                       "nuevas, las convierte y las carga acá. Las notas automáticas dicen sólo los números; la "
                       "lectura con criterio se agrega aparte."),
    ("Cadencia", "Una lectura por viernes alcanza para la tesis. Pesos y emas, más seguido si algo llama la atención."),
    ("Congelamiento", "Del 12-sep al 12-oct-2026 no se toca nada del sistema: sólo se mide y se carga acá."),
    ("Cortes en la serie", "9-sep 02:33 reinicio completo | 9-sep 17:57 neutro forzado | 10-sep tarde arreglo de "
                           "class43 | 11-sep 06:56 capa 2 y voto parejo | 12-sep 04:00 los tres cambios | "
                           "13-sep 00:28 filtro de SELL de class25B apagado. Las filas de antes y después de un "
                           "corte no son comparables entre sí."),
]


def leer_existentes(path):
    """Filas de datos de cada hoja: toda fila cuya columna A sea una fecha."""
    if not path.exists():
        return {h: [] for h in HOJAS}
    wb = load_workbook(path)
    out = {}
    for nombre, d in HOJAS.items():
        if nombre not in wb.sheetnames:   # hoja agregada después: todavía no está en el archivo
            out[nombre] = []
            continue
        ws = wb[nombre]
        filas = []
        for r in range(3, ws.max_row + 1):
            a = ws.cell(row=r, column=1).value
            if not isinstance(a, datetime):
                continue
            fila = [ws.cell(row=r, column=c).value for c in range(1, len(d["headers"]) + 1)]
            for c in d["calc"]:
                fila[c - 1] = None
            filas.append(fila)
        out[nombre] = filas
    return out


def fila_desde_json(nombre, valores):
    d = HOJAS[nombre]
    if len(valores) != len(d["entrada"]):
        raise ValueError(f"{nombre}: se esperaban {len(d['entrada'])} valores y llegaron {len(valores)}")
    fila = [None] * len(d["headers"])
    for col, v in zip(d["entrada"], valores):
        fila[col - 1] = v
    fila[0] = datetime.strptime(fila[0], "%Y-%m-%d %H:%M")
    return fila


def estilo_ejes(g, y_min=None, y_max=None, fmt_y="General"):
    g.x_axis.delete = False           # sin esto openpyxl deja los ejes ocultos
    g.y_axis.delete = False
    g.x_axis.majorGridlines = None
    g.y_axis.majorGridlines = ChartLines()
    g.x_axis.tickLblPos = "low"
    chico = CharacterProperties(sz=800)
    g.x_axis.txPr = RichText(bodyPr=RichTextProperties(rot=-2700000, vert="horz"),
                             p=[Paragraph(pPr=ParagraphProperties(defRPr=chico), endParaRPr=chico)])
    g.y_axis.txPr = RichText(bodyPr=RichTextProperties(rot=0, vert="horz"),
                             p=[Paragraph(pPr=ParagraphProperties(defRPr=chico), endParaRPr=chico)])
    if y_min is not None:
        g.y_axis.scaling.min = y_min
    if y_max is not None:
        g.y_axis.scaling.max = y_max
    g.y_axis.number_format = fmt_y
    for s in g.series:
        s.smooth = False
        s.marker = Marker(symbol="circle", size=6)
    g.dispBlanksAs = "gap"


def grafico(ws, titulo, bloques, fin, ancla, y_tit, y_min=None, y_max=None, alto=11, fmt_y="General",
            destino=None, ancho=26):
    """El eje X es la columna B (texto): con fechas, Excel agrupa por día y dibuja rulos.

    `ws` es la hoja de donde salen los DATOS; `destino`, la hoja donde se dibuja (por defecto
    la misma). Los tres gráficos principales van a la hoja «graficos», que armó Martín el
    30-sep-2026: las referencias siguen apuntando a Pesos y Tesis."""
    g = LineChart()
    g.title, g.y_axis.title = titulo, y_tit
    g.height, g.width = alto, ancho
    for c1, c2 in bloques:
        g.add_data(Reference(ws, min_col=c1, max_col=c2, min_row=2, max_row=fin), titles_from_data=True)
    g.set_categories(Reference(ws, min_col=2, min_row=3, max_row=fin))
    estilo_ejes(g, y_min, y_max, fmt_y)
    (destino or ws).add_chart(g, ancla)


def construir(dest, datos):
    wb = Workbook()
    wb.remove(wb.active)
    # Hoja sólo de gráficos, sin datos. Posiciones y tamaños: los que dejó Martín al moverlos.
    wg = wb.create_sheet(HOJA_GRAFICOS)
    for nombre, d in HOJAS.items():
        ws = wb.create_sheet(nombre)
        ws["A1"] = d["titulo"]
        ws["A1"].font = F_TIT
        for c, (h, w) in enumerate(zip(d["headers"], d["anchos"]), start=1):
            cel = ws.cell(row=2, column=c, value=h)
            cel.font, cel.fill = F_HDR, FILL_HDR
            cel.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            ws.column_dimensions[get_column_letter(c)].width = w
        ws.row_dimensions[2].height = 30
        filas = sorted(datos[nombre], key=lambda f: f[0])
        for i, fila in enumerate(filas, start=3):
            for c, v in enumerate(fila, start=1):
                cel = ws.cell(row=i, column=c, value=d["calc"][c].format(i=i) if c in d["calc"] else v)
                cel.font = F_TXT
                if d["fmts"][c - 1]:
                    cel.number_format = d["fmts"][c - 1]
        fin = 2 + len(filas)
        t = Table(displayName=d["tabla"], ref=f"A2:{get_column_letter(len(d['headers']))}{fin}")
        t.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
        ws.add_table(t)
        ws.freeze_panes = "C3"
        ws.cell(row=fin + 3, column=1, value=d["nota"]).font = F_NOTA

        if nombre == "Pesos":
            # C..G = las cinco familias; I..K = umbral, emisión, decisiones por z (L es la nota: texto)
            grafico(ws, "Peso por fuente en el tiempo", [(3, 7)], fin, "A2", "peso", 0, 1, 13.9, "0.00",
                    destino=wg, ancho=24.8)
            grafico(ws, "Umbral y tasa de emisión", [(9, 11)], fin, "A61", "valor", 0, 1, 6.5, "0.00",
                    destino=wg, ancho=22.4)
        elif nombre == "Tesis":
            grafico(ws, "Ventaja contra la banda de ruido", [(4, 5), (8, 8)], fin, "B36", "puntos porcentuales",
                    fmt_y="0.0", destino=wg)
            grafico(ws, "n_efectivo (ventanas de 48 h no solapadas)", [(3, 3)], fin, "P26", "ventanas",
                    alto=9, fmt_y="#,##0")
        elif nombre == "Redes":
            grafico(ws, "ema de cada red (tiene que tender a 0,5)", [(3, 7)], fin, "R3", "ema de inferencia",
                    0, 1, 11, "0.00")
        elif nombre == "Corte":
            grafico(ws, "Rank IC contra lo mínimo detectable", [(4, 5), (3, 3)], fin, "T3", "rank IC",
                    alto=11, fmt_y="0.000")
        else:
            grafico(ws, "RAM del server contra la alarma del 85%", [(3, 3), (5, 5)], fin, "O3",
                    "fracción de 11,7 GB", 0, 1, 11, "0%")
            grafico(ws, "Memoria por proceso (MB)", [(8, 11)], fin, "O26", "MB", alto=9, fmt_y="#,##0")

    wb.move_sheet(wg, offset=1 - wb.index(wg))      # segunda, detrás de Pesos: donde la puso Martín
    ws = wb.create_sheet("Como cargar")
    ws["A1"] = "Cómo cargar una medición"
    ws["A1"].font = F_TIT
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 118
    for r, (a, b) in enumerate(GUIA, start=3):
        ws.cell(row=r, column=1, value=a).font = Font(name="Arial", size=10, bold=True)
        c = ws.cell(row=r, column=2, value=b)
        c.font = F_TXT
        c.alignment = Alignment(wrap_text=True, vertical="top")
    wb.save(dest)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__ if __doc__ else "uso: actualizar_planilla.py nuevas.json [--destino archivo.xlsx]")
        sys.exit(1)
    dest = DESTINO
    if "--destino" in args:
        dest = Path(args[args.index("--destino") + 1])
    nuevas = json.loads(Path(args[0]).read_text(encoding="utf-8"))

    datos = leer_existentes(dest)
    agregadas = {}
    for nombre in HOJAS:
        ya = {f[0] for f in datos[nombre]}
        n = 0
        for valores in nuevas.get(nombre, []):
            fila = fila_desde_json(nombre, valores)
            if fila[0] in ya:
                continue
            datos[nombre].append(fila)
            ya.add(fila[0])
            n += 1
        agregadas[nombre] = n

    try:
        construir(dest, datos)
    except PermissionError:
        print(f"No se pudo escribir {dest}: está abierto en Excel. Cerralo y volvé a correr el script.")
        sys.exit(2)
    for nombre in HOJAS:
        print(f"{nombre}: {len(datos[nombre])} filas ({agregadas[nombre]} nuevas)")


if __name__ == "__main__":
    main()
