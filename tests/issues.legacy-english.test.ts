import { describe, expect, it } from "vitest";
import { translateLegacyMessage } from "../src/shared/legacy-english";
import { parsePage } from "../src/parsers/page";
import { issueCatalog } from "../src/issues/catalog";

describe("English legacy diagnostics overlay", () => {
  it.each([
    ["La URL no es válida.", "The URL is invalid."],
    ["Comprobando robots.txt…", "Checking robots.txt…"],
    ["Auditoría completada.", "Audit completed."],
    ["Auditoría en espera.", "Audit queued."],
    ["La auditoría falló. Las páginas procesadas se conservaron.", "The audit failed. Processed pages have been retained."],
    ["Auditoría interrumpida al reiniciar la aplicación. Las páginas procesadas se conservaron.", "Audit interrupted when the application restarted. Processed pages have been retained."],
    ["El proceso se cerró antes de terminar la auditoría.", "The process stopped before the audit finished."],
    ["Revisadas 4 de hasta 100 URLs…", "Checked 4 of up to 100 URLs…"],
    ["La respuesta descomprimida excede el límite de 2000 bytes.", "The decompressed response exceeds the limit of 2000 bytes."],
    ["Timeout de solicitud (10000 ms).", "Request timed out (10000 ms)."],
    ["Sitemap XML inválido: etiquetas no balanceadas.", "Invalid sitemap XML: unbalanced tags."],
    ["2 páginas con texto normalizado idéntico; hash abc123; 105 palabras.", "2 pages with identical normalized text; hash abc123; 105 words."],
    ["HTTP 404; destino: https://example.com/español", "HTTP 404; destination: https://example.com/español"],
    ["3 saltos → https://example.com/final", "3 hops → https://example.com/final"],
    ["Muestra: 100/100 páginas máximas; sitemap truncado; navegación sin JavaScript. No confirma orfandad.", "Sample: 100/100 maximum pages; sitemap truncated; navigation without JavaScript. This does not confirm orphan status."],
    ["Patrones reconocidos en HTML: Google Analytics. No se ejecutaron scripts.", "Patterns recognized in HTML: Google Analytics. Scripts were not executed."],
    ["Title faltante", "Missing title"],
  ])("translates a known authored diagnostic: %s", (legacy, english) => {
    expect(translateLegacyMessage(legacy)).toBe(english);
    expect(translateLegacyMessage(english)).toBe(english);
  });
  it("preserves actual page text inside diagnostic evidence and raw source text", () => {
    const original = "Inicio: Una descripción de imágenes sin alt y contenido español";
    expect(translateLegacyMessage(original)).toBe(original);
    expect(translateLegacyMessage(`72 caracteres: ${original}`)).toBe(`72 characters: ${original}`);
    expect(translateLegacyMessage(`2 páginas con el mismo title: ${original}`)).toBe(`2 pages with the same title: ${original}`);
    expect(translateLegacyMessage(`Enlace a https://example.com/rotó; respuesta HTTP 404; texto: ${original}.`)).toBe(`Link to https://example.com/rotó; HTTP 404; text: ${original}.`);
    expect(translateLegacyMessage(`Inicio → H3: ${original}`)).toBe(`Start → H3: ${original}`);
  });
  it("translates nested request errors and multiple sitemap failures", () => {
    expect(translateLegacyMessage("La respuesta excede el límite de 1000 bytes.; último status recibido: 200")).toBe("The response exceeds the limit of 1000 bytes.; last received status: 200");
    const error = "https://example.com/map.xml: Sitemap XML inválido: etiqueta sin cerrar.";
    const translated = "https://example.com/map.xml: Invalid sitemap XML: unclosed tag.";
    expect(translateLegacyMessage(error)).toBe(translated);
    expect(translateLegacyMessage(`Sitemap incompleto o no accesible: ${error}\nhttps://example.com/other.xml: Timeout de solicitud (3000 ms).`)).toBe(`Sitemap incomplete or inaccessible: ${translated}\nhttps://example.com/other.xml: Request timed out (3000 ms).`);
    expect(translateLegacyMessage(`Documentos consultados: ninguno utilizable. ${error}`)).toBe(`Documents checked: none usable. ${translated}`);
  });
  it("translates JSON-LD paths and preserves source identifiers and parser error details", () => {
    expect(translateLegacyMessage("Bloque 2.@graph[0].autor[1]: falta @context; revisar si es un documento JSON-LD completo.")).toBe("Block 2.@graph[0].autor[1]: missing @context; check whether this is a complete JSON-LD document.");
    expect(translateLegacyMessage("Bloque 1: @id repetido con propiedades diferentes: #organización")).toBe("Block 1: repeated @id with different properties: #organización");
    expect(translateLegacyMessage("Bloque 1: Unexpected token 'á'")).toBe("Block 1: Unexpected token 'á'");
  });
  it("keeps parsed website language and content unchanged while authored diagnostics are English", () => {
    const parsed = parsePage('<html lang="es"><title>Mi sitio español</title><meta name="description" content="Una descripción original"><main><h1>Bienvenidos</h1><p>Contenido original</p></main><script type="application/ld+json">{"@type":"Thing"}</script></html>', 'https://example.com/');
    expect(parsed.title).toBe('Mi sitio español');
    expect(parsed.description).toBe('Una descripción original');
    expect(parsed.language).toBe('es');
    expect(parsed.h1).toEqual(['Bienvenidos']);
    expect(parsed.contentSample).toContain('Contenido original');
    expect(parsed.schemaWarnings[0]).toContain('missing @context');
    expect(issueCatalog.title_missing.name).toBe('Missing title');
  });
});
