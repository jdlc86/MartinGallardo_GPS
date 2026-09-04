> **DOCUMENTO HISTÓRICO — NO NORMATIVO.** Describe una etapa anterior del diseño del Asistente IA. Para comportamiento vigente consultar `README.md`, `docs/ARCHITECTURE.md`, `docs/STABLE_RELEASE.md`, `docs/TEST_PLAN.md` y `docs/MAINTENANCE_AUDIT_2026-09-04.md`. Ante contradicción, prevalece la documentación vigente.

ParkingMartin-G
Diseño funcional y técnico del Asistente IA para asignación eficiente de operarios
Documento de arquitectura y requisitos · Septiembre 2026
## 1. Objetivo
Incorporar en Gestión de Reservas un botón de “Asistente IA” que ayude a Root/Admin a distribuir de forma eficiente las tareas de recogida y entrega entre los operarios. El sistema debe respetar restricciones duras, experiencia, disponibilidad, carga de trabajo y tiempos reales de desplazamiento. La IA debe conversar con el administrador, pedir únicamente la información que realmente falte y explicar la propuesta. La asignación no se ejecutará de forma silenciosa: el resultado será una propuesta que deberá pasar por los controles de permisos y concurrencia existentes.
## 2. Principio de arquitectura
No se recomienda que un LLM decida por sí solo el reparto. La solución se divide en dos capas: un motor de optimización determinista calcula una solución factible/óptima y la IA actúa como interfaz conversacional, interpreta requisitos administrativos, solicita datos faltantes y explica el resultado.
Datos operativos + reglas + tiempos → Motor de optimización → Propuesta → IA/Chat → Confirmación Admin → API de asignación
## 3. Variables y restricciones del optimizador
- Tareas independientes: Cada reserva genera pickup y delivery independientes. Pueden asignarse a personas distintas.
- Horario: La fecha/hora de cada tarea y el margen operativo deben respetarse.
- Operarios activos: Un operario inactivo queda excluido automáticamente y no debe aparecer como candidato.
- Experiencia: Cada operario se clasifica como BAJO, MEDIO o EXPERTO.
- Gama alta: RESTRICCIÓN DURA: un vehículo clasificado como GAMA_ALTA solo puede ser asignado a un operario EXPERTO. La optimización no puede relajar esta regla.
- Carga de trabajo: Debe evitarse la concentración innecesaria de tareas en un único operario y buscar un reparto razonablemente equilibrado.
- Desplazamientos: Se consideran los tiempos Parking↔Terminales y Terminal↔Terminal, además del tiempo propio de cada operación.
- Encadenamiento: Se favorecen secuencias eficientes, por ejemplo terminar en T4 y realizar otra operación cercana en T4 sin regresar innecesariamente al parking.
- Traslado conjunto: El modelo futuro debe contemplar que varios operarios puedan desplazarse juntos en un vehículo, reduciendo movimientos de lanzadera.
- Reoptimización: Ante retrasos, nuevas reservas, desactivaciones o cambios operativos, se recalcula únicamente lo que todavía puede modificarse, preservando tareas ya iniciadas/completadas.
## 4. Experiencia y clasificación de vehículos
La experiencia es información persistente del trabajador. Propuesta de dominio:
Para vehículos se propone separar la clasificación del nombre de la marca: NORMAL o GAMA_ALTA. Si un vehículo es GAMA_ALTA, EXPERTO es obligatorio. Si la clasificación necesaria no existe, el asistente debe forzar al Admin a clasificarlo antes de usarlo en una asignación automática.
No conviene inferir de forma irrevocable “Maserati = gama alta” únicamente por texto de marca. Puede existir un catálogo/heurística para sugerir la clasificación, pero el dato persistente y auditable debe ser la clasificación del vehículo/reserva.
## 5. Memoria persistente y contexto dinámico
La memoria no debe depender de un único system prompt estático. En cada turno se construirá un contexto dinámico desde Supabase, combinado con el contexto conversacional privado del usuario. De esta forma el asistente conoce siempre el estado vigente del negocio y evita repetir preguntas ya resueltas.
- Reglas globales persistentes: Restricciones del negocio, política de gama alta, márgenes, criterios de equilibrio y parámetros del optimizador.
- Datos estructurados: Operarios, experiencia, activo/inactivo, tareas, reservas, clasificación del vehículo, tiempos de desplazamiento, disponibilidad y carga.
- Contexto conversacional por usuario: Historial necesario para continuar la conversación de ese administrador sin mezclarlo con conversaciones de otros usuarios.
- Estado operativo en tiempo real: Se vuelve a consultar en cada turno. Una conversación larga nunca debe congelar permisos, tareas ni disponibilidad antiguos.
## 6. Política de preguntas de la IA
Antes de preguntar, el backend/asistente debe comprobar si el dato ya existe y sigue siendo válido. La IA no debe repetir preguntas que el sistema ya puede responder.
- Si entra un operario nuevo y no tiene experience_level, preguntar BAJO / MEDIO / EXPERTO y persistir la respuesta.
- Si el operario está inactivo, ignorarlo; no preguntar por su experiencia para esa optimización.
- Si un vehículo relevante no tiene clasificación y esta es necesaria para garantizar la regla de gama alta, solicitar la clasificación al Admin y guardarla.
- Si un dato ya está persistido, no volver a preguntarlo salvo que el Admin solicite modificarlo.
- Distinguir preguntas bloqueantes de advertencias no bloqueantes. Una restricción de seguridad/experiencia no puede resolverse con una suposición silenciosa.
## 7. Modelo de tiempos y movilidad
Para una primera versión se recomienda una matriz de tiempos calibrada entre Parking, T1, T2, T3/T4/T4S según las ubicaciones operativas reales. El optimizador usará esos tiempos junto con duración de recepción, fotos, aparcamiento, entrega y márgenes. Posteriormente los tiempos pueden ajustarse por franja horaria usando datos históricos/GPS.
Ejemplo conceptual: Parking→T4, T4→Parking, T1→T4, etc. Los valores concretos deben calibrarse con la operación real y no inventarse en el modelo.
## 8. Seguridad, permisos y aislamiento de sesiones
Esta parte es una condición de seguridad. La IA nunca debe consumir indiscriminadamente los mensajes que llegan por Telegram. Todo texto debe atravesar una pasarela de autorización antes de llegar al modelo.
Mensaje Telegram → validar telegram_user_id → active → permiso vigente lectura/escritura → sesión IA del usuario → modelo
- Solo un usuario con permiso vigente de lectura/escritura de Gestión de Reservas puede interactuar con el asistente.
- El permiso se verifica EN CADA MENSAJE, no únicamente al abrir la sesión.
- Las notificaciones de Telegram y eventos del sistema no son entradas conversacionales para la IA.
- Un texto de otro usuario no debe incorporarse al contexto de la sesión, aunque llegue al mismo bot/canal.
- Cada sesión se asocia como mínimo a telegram_user_id + ai_session_id.
- Si el usuario pierde el permiso a mitad de la sesión, sus siguientes mensajes dejan de procesarse inmediatamente.
- Si posteriormente recupera permiso, puede reanudar su propio contexto según la política de retención, pero nunca hereda el contexto privado de otro Admin.
- Si el permiso de escritura se transfiere a otro administrador, el nuevo titular utiliza su propia sesión/contexto.
- La IA no escribe directamente en tablas. Una propuesta confirmada utiliza las APIs/RPC existentes, incluyendo control de versión y permisos.
## 9. Contexto por usuario frente a contexto compartido
El contexto compartido se reconstruye/actualiza desde Supabase en cada turno. El contexto privado no se mezcla entre administradores.
## 10. Flujo de interacción propuesto
1. Root/Admin pulsa “Asistente IA” en Gestión de Reservas.
2. El backend valida identidad, actividad y permiso vigente de lectura/escritura.
3. Se crea o recupera la sesión privada del telegram_user_id.
4. Se carga el contexto dinámico del negocio y se detectan datos bloqueantes faltantes.
5. Si falta experiencia o clasificación, la IA pregunta únicamente por esos datos y la respuesta se persiste.
6. El motor de optimización calcula una propuesta factible respetando restricciones duras.
7. La IA presenta por chat el reparto, motivos, carga, desplazamientos y posibles incidencias.
8. El Admin confirma o solicita cambios.
9. Antes de ejecutar se vuelven a validar permisos y versiones de las tareas.
10. La API existente realiza la asignación; la última asignación confirmada sigue siendo la válida.
## 11. Datos adicionales recomendados
Diseño conceptual; los nombres definitivos deben revisarse contra el esquema actual antes de crear migraciones.
## 12. Función objetivo orientativa
El optimizador debe encontrar primero una solución que cumpla todas las restricciones duras y, entre las soluciones válidas, minimizar una combinación ponderada de:
- tiempo total de desplazamiento
- kilómetros/movimientos innecesarios
- riesgo de llegar tarde
- desequilibrio de carga entre operarios
- tiempos muertos
- número de retornos innecesarios al parking
El transporte conjunto de operarios se incorporará como una extensión del modelo una vez validada la V1, porque introduce dependencias entre rutas y recursos compartidos.
## 13. Alcance recomendado de V1
- Botón Asistente IA solo para usuarios autorizados.
- Sesiones independientes por telegram_user_id y revalidación de permisos en cada mensaje.
- Experiencia persistente de operarios.
- Clasificación NORMAL/GAMA_ALTA y EXPERTO obligatorio para gama alta.
- Solo operarios activos y disponibles.
- Pickup y delivery como tareas independientes.
- Matriz de tiempos Parking/Terminales.
- Balance de carga y compatibilidad temporal.
- Motor de optimización determinista (p. ej. OR-Tools/CP-SAT).
- IA para diálogo, detección de datos faltantes y explicación.
- Confirmación humana antes de ejecutar cambios.
- Uso de reservation-task-api/RPC y control de version para materializar asignaciones.
## 14. Reglas que no deben romperse
- La asignación de una tarea no cambia el estado operativo del coche.
- Una tarea completed/cancelled no debe volver a asignarse.
- Un operario inactivo no es candidato.
- GAMA_ALTA nunca se asigna automáticamente a BAJO o MEDIO.
- El LLM no debe poder saltarse restricciones del solver/backend.
- Una notificación Telegram nunca debe interpretarse como una instrucción del Admin.
- No confiar en permisos almacenados al inicio de sesión: se revalidan en cada turno y antes de cualquier escritura.
- No mezclar conversaciones/contextos privados de diferentes usuarios.
## 15. Próximo paso antes de implementar
Antes de modificar código o base de datos se debe revisar el esquema y APIs actuales, definir los tiempos operativos reales, disponibilidad/turnos y reglas exactas de clasificación. Después se puede diseñar la migración mínima y un prototipo del optimizador que opere primero en modo propuesta, sin escritura automática.

| Operario | experience_level |
| --- | --- |
| Nivel bajo | LOW / BAJO |
| Nivel medio | MEDIUM / MEDIO |
| Experto | EXPERT / EXPERTO |


| Contexto privado del usuario | Contexto compartido del negocio |
| --- | --- |
| Conversación del Admin con el asistente | Reglas globales de optimización |
| Aclaraciones temporales dadas por ese Admin | Operarios activos y experiencia |
| Propuestas previas de su sesión | Reservas y tareas actuales |
| Preferencias conversacionales que no sean reglas globales | Tiempos, clasificación de vehículos y carga |


| Entidad | Campo/tabla conceptual | Uso |
| --- | --- | --- |
| workers | experience_level | BAJO / MEDIO / EXPERTO |
| vehicle/reservation | vehicle_handling_level | NORMAL / GAMA_ALTA |
| dispatch configuration | dispatch_rules | Reglas versionadas y parámetros |
| travel model | travel_times | Tiempos entre ubicaciones/franjas |
| AI assistant | ai_sessions | Sesión por telegram_user_id |
| AI assistant | ai_messages / session context | Contexto conversacional auditable según política de retención |
| availability | worker_availability | Disponibilidad/turnos/excepciones |


## 16. Ampliación: planificación semanal, movilidad y kilometraje

La planificación se realizará para un horizonte elegido por el Admin (por defecto puede proponerse esta semana, próximos 3 días o periodo personalizado). El optimizador debe generar tanto la asignación de tareas como el itinerario operativo de cada trabajador entre tareas.

### 16.1 Asignaciones manuales preexistentes

Antes de optimizar un periodo, el sistema debe cargar todas las asignaciones ya confirmadas manualmente dentro de ese horizonte. Estas asignaciones se consideran decisiones del Admin y deben preservarse como restricciones fijas, salvo que el Admin solicite expresamente reconsiderarlas.

Esto permite que el Admin pueda realizar excepciones operativas conscientes. Por ejemplo, aunque la regla automática sea GAMA_ALTA → EXPERTO, si el Admin ya asignó manualmente ese vehículo a un operario BAJO o MEDIO, el optimizador no debe deshacer ni bloquear retroactivamente esa decisión. Debe respetarla, señalarla en el informe como excepción manual y planificar el resto alrededor de ella.

### 16.2 Matriz de marca y gama

Se mantendrá una matriz/catálogo persistente `MARCA DE VEHÍCULO → GAMA` para ayudar a clasificar automáticamente las reservas. La clasificación relevante inicial es `NORMAL` o `GAMA_ALTA`. Un vehículo identificado como GAMA_ALTA requiere EXPERTO en la asignación automática.

El catálogo por marca es una ayuda persistente. Debe existir posibilidad de excepción por vehículo/reserva cuando sea necesario. Si la IA detecta una marca nueva sin clasificación y el dato es bloqueante, debe preguntar al Admin y persistir la respuesta.

### 16.3 Matriz completa de distancias

El optimizador debe disponer de una matriz dirigida de kilómetros estimados entre todos los nodos operativos. Como mínimo: Parking, T1, T2, T3, T4 y T4S. Debe existir además una matriz separada de tiempos de desplazamiento.

### 16.4 Regla de kilometraje estimado del coche del cliente

El sistema NO utilizará la fotografía/lectura inicial del odómetro para el optimizador. Esa fotografía pertenece a la evidencia operativa. La planificación trabaja únicamente con kilómetros estimados derivados de la matriz de distancias.

**km máximos planificables = km lógicos estimados del servicio + 4 km de margen operativo**

Ejemplo: si T4→Parking son 10 km y Parking→T4 son 10 km, el servicio lógico son 20 km y el máximo planificable será 24 km. Cualquier desvío propuesto para transportar compañeros debe caber dentro de ese límite estimado.

### 16.5 Medios de desplazamiento permitidos

- No existe coche de empresa.
- Parking ↔ aeropuerto: coche de cliente de una operación o acompañamiento con otro operario que conduce un coche de cliente.
- Terminal ↔ Terminal: lanzadera del aeropuerto como opción preferente cuando sea temporalmente viable.
- Terminal ↔ Terminal en coche de cliente con un compañero: solo si es compatible con la ruta/tarea, la ventana temporal y el límite de kilometraje del coche.
- Un traslado compartido crea una dependencia entre los itinerarios de ambos operarios.

### 16.6 Prioridad de la lanzadera

La lanzadera tiene prioridad para movimientos entre terminales siempre que permita llegar a la siguiente tarea dentro de la ventana temporal. El solver solo debe sustituirla por traslado con compañero cuando no sea viable temporalmente o exista una razón operativa válida, sin violar kilometraje ni otras restricciones.

### 16.7 Resultado: plan e informe operativo

Cada planificación debe producir un informe para Admin y un itinerario listo para enviar a cada operario. Debe incluir tareas y desplazamientos, indicando lanzadera o acompañamiento con compañero, horas estimadas y dependencias.

### 16.8 Confirmación y ejecución

La IA propone y el Admin confirma. Una vez confirmada la propuesta, las asignaciones deben ejecutarse mediante exactamente el mismo workflow existente de asignación manual (`reservation-task-api` / RPC), conservando permisos, control de `version`, historial, Realtime y notificaciones.

## 17. Ampliación: horarios de lanzadera y tiempo operativo por servicio

### 17.1 Matriz de horarios y tiempos de lanzadera entre terminales

Además de las matrices de distancia y tiempo por carretera, el optimizador debe disponer de una matriz específica de lanzadera entre terminales. Debe describir conexiones, horarios operativos, frecuencia o salidas y tiempo de trayecto. El acceso desde el punto operativo de la terminal hasta la parada de lanzadera se considera por defecto de 5 minutos.

La lanzadera solo es viable si existe un servicio compatible y permite al operario llegar a la siguiente tarea dentro de la ventana temporal.

Para calcular la llegada real se debe considerar:

- 5 minutos por defecto para llegar desde el punto operativo de la terminal hasta la parada;
- tiempo de espera variable hasta la siguiente salida válida de la lanzadera;
- tiempo de trayecto;
- desembarque y desplazamiento hasta el punto operativo de la terminal.

El tiempo de espera NO se fija como constante. Se calcula dinámicamente a partir de la hora real de llegada del operario a la parada y de los horarios/frecuencias guardados en la matriz de lanzaderas.

### 17.2 Regla de 10 minutos operativos por recogida y entrega

Cada tarea `pickup` y `delivery` reserva obligatoriamente **10 minutos de tiempo operativo** para la rutina con vehículo/cliente.

**Duración mínima bloqueada: pickup = 10 min · delivery = 10 min**

Durante esos 10 minutos el operario no está disponible para iniciar otro desplazamiento ni otra tarea.

Ejemplo: una entrega a las 10:00 ocupa al operario como mínimo de 10:00 a 10:10. Si después va de T1 a T4 en lanzadera, la transición empieza a partir de las 10:10.

### 17.3 Composición temporal completa de una transición

**fin tarea anterior + 10 min operativos + acceso/espera + desplazamiento + margen de llegada ≤ inicio de la siguiente tarea**

Cuando el desplazamiento sea en coche de cliente o como acompañante, se usa la matriz de conducción y las restricciones de kilometraje correspondientes.

### 17.4 Implicaciones para el informe del operario

El itinerario debe indicar cuándo termina realmente el bloque operativo, cómo se mueve a la siguiente operación, horarios de lanzadera cuando apliquen y alternativas si la lanzadera no cabe en la ventana temporal.

### 17.5 Datos configurables

Los 10 minutos operativos deben almacenarse como parámetro global configurable. El tiempo de acceso a la parada se inicializa en 5 minutos por defecto y también conviene mantenerlo configurable. Los horarios, frecuencias y tiempos de trayecto de la lanzadera deben mantenerse en datos estructurados actualizables sin modificar el solver. El tiempo de espera nunca se persiste como valor fijo: se deriva en cada transición a partir de la próxima salida disponible.
