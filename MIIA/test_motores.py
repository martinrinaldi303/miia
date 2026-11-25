# ==========================================================
# test_motores.py — Diagnóstico rápido de MIIA (v1.1-R)
# ==========================================================
# Comprueba la inicialización y funcionamiento básico de
# todos los motores Python del núcleo emocional y cognitivo.
# ==========================================================

import asyncio
import logging
# ==========================================================
# IMPORTAR MOTORES
# ==========================================================
from MotorEmocional import MotorEmocional
from MotorGrafico import MotorGrafico
from MotorLenguaje import MotorLenguaje
from modulo_de_control import ModuloControl
from MotorMovimiento import MotorMovimiento

# ----------------------------------------------------------
# Configuración de logging
# ----------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_motores")


async def test_motores():
    log.info("Iniciando test de motores MIIA...\n")

    try:
        # Instancias principales
        emocional = MotorEmocional()
        lenguaje = MotorLenguaje()
        grafico = MotorGrafico()
        movimiento = MotorMovimiento()
        control = ModuloControl()

        # -------------------------
        # 1️⃣ Motor Emocional
        # -------------------------
        log.info("Probando MotorEmocional...")
        emo_res = await emocional.analizar_consolidado(texto="Estoy feliz y motivado")
        log.info(f"MotorEmocional → {emo_res}")

        # -------------------------
        # 2️⃣ Motor de Lenguaje
        # -------------------------
        log.info("Probando MotorLenguaje...")
        lang_res = lenguaje.procesar_decision({
            "resultado": "alto",
            "score": 0.9,
            "tendencia": "ALCISTA",
            "confianza": 0.85
        }, perfil_usuario="novato", user_id="user_test")
        log.info(f"MotorLenguaje → {lang_res}")

        # -------------------------
        # 3️⃣ Motor de Movimiento
        # -------------------------
        log.info("Probando MotorMovimiento...")
        mov_res = movimiento.generar("alegria", contexto={"energia": 0.7, "ritmo": 0.5})
        log.info(f"MotorMovimiento → {mov_res}")

        # -------------------------
        # 4️⃣ Motor Gráfico
        # -------------------------
        log.info("Probando MotorGrafico...")
        # Genera un gráfico rápido de prueba local
        test_data = {
            "user_id": "user_test",
            "portfolio": [
                {"symbol": "TEST", "qty": 2, "price": 100.0}
            ]
        }
        grafico.push_update(test_data)
        log.info("MotorGrafico → gráfico generado y guardado correctamente.")

        # -------------------------
        # 5️⃣ Módulo de Control
        # -------------------------
        log.info("Probando ModuloDeControl...")
        ctrl_res = control.actualizar_estado(emocion="alegria", contexto="positivo")
        log.info(f"ModuloDeControl → {ctrl_res}")

        # -------------------------
        # 6️⃣ Resumen final
        # -------------------------
        log.info("\nTodos los motores respondieron correctamente.\n")
        print("===== RESUMEN MIIA =====")
        print("Emocional:", emo_res)
        print("Lenguaje:", lang_res)
        print("Movimiento:", mov_res)
        print("Control:", ctrl_res)
        print("Gráfico generado: ver carpeta /operador/aprendizaje/reportes/\n")

    except Exception as e:
        log.exception(f"Error durante el test de motores: {e}")


if __name__ == "__main__":
    asyncio.run(test_motores())
