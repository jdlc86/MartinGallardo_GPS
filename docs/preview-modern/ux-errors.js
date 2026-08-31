(function(){
  const TECHNICAL_PATTERNS=[/^HTTP\s+\d+/i,/^telegram_/i,/^vision_/i,/^PGRST/i,/^42[A-Z0-9]{3}/i,/^JS ERROR:/i,/^Respuesta no JSON/i,/^Unauthorized$/i,/^Not authorized$/i,/^Access denied$/i];
  const MAP={
    expired_init_data:'Tu sesión de ParkingMartin-G ha caducado. Cierra esta pantalla y vuelve a abrir la aplicación desde Telegram.',
    invalid_init_data:'No hemos podido validar tu sesión de Telegram. Cierra esta pantalla y vuelve a abrir ParkingMartin-G desde el bot.',
    missing_user:'No hemos podido identificar tu usuario de Telegram. Vuelve al chat del bot y abre ParkingMartin-G de nuevo.',
    not_authorized:'Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.',
    unauthorized:'Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.',
    'Not authorized':'Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.',
    'Unauthorized':'Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.',
    'Access denied':'No tienes acceso a esta sección. Si crees que se trata de un error, contacta con un administrador.',
    not_admin:'No tienes permisos para realizar esta acción. Se necesita rol Root o Admin.',
    self_change_not_allowed:'No puedes modificar tus propios permisos desde este panel.',
    owner_protected:'La cuenta Root está protegida y no puede modificarse desde este panel.',
    target_not_found:'No se ha encontrado ese usuario. Actualiza la pantalla y vuelve a intentarlo.',
    request_not_pending:'Esta solicitud ya no está pendiente. Actualiza la pantalla para ver su estado actual.',
    invalid_target:'No se ha podido identificar al usuario seleccionado. Actualiza la pantalla y vuelve a intentarlo.',
    invalid_admin_action:'Esa acción administrativa ya no está disponible. Actualiza la pantalla y vuelve a intentarlo.',
    invalid_action:'Esta acción no está disponible en la versión actual. Vuelve al inicio y prueba de nuevo.',
    method_not_allowed:'No se pudo completar la solicitud. Vuelve a intentarlo desde la aplicación.',
    origin_not_allowed:'Por seguridad, esta pantalla debe abrirse desde ParkingMartin-G dentro de Telegram.',
    vehicle_not_found:'No encontramos ese vehículo. Revisa la matrícula y vuelve a intentarlo.',
    not_found:'No encontramos la información solicitada. Revisa los datos y vuelve a intentarlo.',
    already_parked:'Ese vehículo ya figura como aparcado. Consulta su expediente antes de continuar.',
    not_parked:'Ese vehículo ya no figura como aparcado. Actualiza la información antes de continuar.',
    state_changed:'El estado del vehículo ha cambiado desde que abriste esta pantalla. Actualiza y vuelve a intentarlo.',
    verification_required:'Antes de continuar debes verificar la matrícula.',
    verification_not_accepted:'La verificación de matrícula no está aceptada. Repite la foto o usa la opción de continuar disponible en el flujo.',
    verification_not_found:'No encontramos la verificación de matrícula. Repite la foto y vuelve a intentarlo.',
    invalid_override:'No se pudo registrar la confirmación manual. Repite la verificación y vuelve a intentarlo.',
    invalid_plate:'La matrícula no parece válida. Revísala y vuelve a intentarlo.',
    invalid_coordinates:'No hemos podido obtener una ubicación válida. Activa el GPS e inténtalo de nuevo.',
    location_description_required:'La precisión del GPS no es suficiente. Añade una referencia breve de dónde está el coche para continuar.',
    invalid_image:'No hemos podido usar esa imagen. Haz una foto nueva o selecciónala de nuevo.',
    invalid_image_size:'La imagen no tiene un tamaño válido. Haz una foto nueva con la cámara del teléfono.',
    invalid_file_size:'El archivo no tiene un tamaño válido. Selecciona otro archivo o vuelve a capturarlo.',
    provider_not_configured:'La verificación automática no está disponible temporalmente. Vuelve a intentarlo en unos minutos.',
    network_error:'No hay conexión suficiente con el sistema. Comprueba Internet y vuelve a intentarlo.'
  };
  function normalize(value){
    if(value==null)return '';
    if(typeof value==='object'&&value.message)value=value.message;
    return String(value).trim();
  }
  function friendly(value){
    const raw=normalize(value);
    if(!raw)return 'No se pudo completar la operación. Vuelve a intentarlo.';
    if(MAP[raw])return MAP[raw];
    const lower=raw.toLowerCase();
    if(lower==='not authorized'||lower==='unauthorized'||lower.includes('access denied'))return 'Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.';
    if(lower.includes('failed to fetch')||lower.includes('networkerror')||lower.includes('network request failed')||lower.includes('load failed'))return 'No hemos podido conectar con el sistema. Comprueba tu conexión a Internet y vuelve a intentarlo.';
    if(lower.includes('timeout')||lower.includes('timed out'))return 'La operación está tardando demasiado. Comprueba la conexión y vuelve a intentarlo.';
    if(lower.includes('permission denied')||lower.includes('not allowed'))return 'No tienes permisos para completar esta acción.';
    if(lower.includes('camera')&&lower.includes('permission'))return 'ParkingMartin-G necesita permiso para usar la cámara. Actívalo en los ajustes del teléfono y vuelve a intentarlo.';
    if(lower.includes('geolocation')&&lower.includes('permission'))return 'ParkingMartin-G necesita acceso a tu ubicación. Activa el permiso de ubicación y vuelve a intentarlo.';
    if(TECHNICAL_PATTERNS.some(r=>r.test(raw))||/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(raw))return 'No se pudo completar la operación. Actualiza la pantalla y vuelve a intentarlo. Si continúa ocurriendo, avisa a un administrador.';
    return raw;
  }
  window.PMGFriendlyError=friendly;
  window.PMGTechnicalErrorMap=MAP;
  const NativeError=window.Error;
  function FriendlyError(message,options){
    const e=new NativeError(friendly(message),options);
    Object.setPrototypeOf(e,FriendlyError.prototype);
    return e;
  }
  FriendlyError.prototype=NativeError.prototype;
  Object.setPrototypeOf(FriendlyError,NativeError);
  window.Error=FriendlyError;
})();
