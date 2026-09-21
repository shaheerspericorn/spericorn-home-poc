"""Typed, user-presentable failures. The Node backend relays `code` and `message` verbatim."""


class CadWorkerError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# Conversion (DWG -> DXF)
CONVERTER_NOT_FOUND = "CONVERTER_NOT_FOUND"
CONVERTER_NO_DISPLAY = "CONVERTER_NO_DISPLAY"
CONVERSION_TIMEOUT = "CONVERSION_TIMEOUT"
CONVERSION_FAILED = "CONVERSION_FAILED"
INPUT_NOT_FOUND = "INPUT_NOT_FOUND"
INPUT_NOT_DWG = "INPUT_NOT_DWG"
UNSUPPORTED_DWG_VERSION = "UNSUPPORTED_DWG_VERSION"
PERMISSION_DENIED = "PERMISSION_DENIED"
UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"

# Parsing / detection / generation
DXF_PARSE_ERROR = "DXF_PARSE_ERROR"
UNSUPPORTED_UNITS = "UNSUPPORTED_UNITS"
NO_GEOMETRY = "NO_GEOMETRY"
NO_WALLS = "NO_WALLS"
INVALID_GEOMETRY = "INVALID_GEOMETRY"
GLB_EXPORT_FAILED = "GLB_EXPORT_FAILED"

NO_WALLS_MESSAGE = (
    "DWG was parsed successfully, but no wall geometry could be reliably detected. "
    "Please check the drawing layers or provide a drawing that follows the supported architectural CAD conventions."
)
