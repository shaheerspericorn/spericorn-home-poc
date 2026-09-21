import { appConfig } from "../../config.js";
import { ApsCadConversionService } from "../../infrastructure/aps/autodesk-aps-conversion-service.js";
import { LocalCadConversionService } from "../../infrastructure/local/local-cad-conversion-service.js";
import { SampleModeConversionService } from "../../infrastructure/sample/sample-mode-conversion-service.js";
import type { CadConversionService } from "../../types/conversion.js";
import { FileSystemStorage } from "../storage/file-system-storage.js";

/** Selects one converter at composition time; controllers and model jobs stay provider-agnostic. */
export function createCadConversionService(storage: FileSystemStorage): CadConversionService {
  switch (appConfig.cadConversionProvider) {
    case "sample": return new SampleModeConversionService(storage);
    case "local": return new LocalCadConversionService(storage);
    case "aps": return new ApsCadConversionService(storage);
  }
}
