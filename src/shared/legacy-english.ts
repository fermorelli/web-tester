import legacyMessages from "./legacy-english-messages.json";

const exact: Readonly<Record<string, string>> = {
  ...legacyMessages,
  "Comprobando robots.txt…": "Checking robots.txt…",
  "Buscando sitemaps…": "Looking for sitemaps…",
  "Rastreando páginas y analizando HTML…": "Crawling pages and analyzing HTML…",
  "Comprobando tamaños de imágenes disponibles…": "Checking available image sizes…",
  "Consolidando problemas…": "Consolidating issues…",
  "En cola…": "Queued…",
  "Análisis en cola.": "Audit queued.",
  "En cola": "Queued",
  "Preparando análisis…": "Preparing audit…",
  "Análisis completado.": "Audit completed.",
  "Análisis interrumpido. Se conservan las páginas procesadas.": "Audit interrupted. Processed pages have been retained.",
  "Análisis fallido. Se conservan las páginas procesadas.": "The audit failed. Processed pages have been retained.",
  "El proceso se detuvo antes de terminar el análisis.": "The process stopped before the audit finished.",
  "Auditoría en espera.": "Audit queued.",
  "Auditoría completada.": "Audit completed.",
  "La auditoría falló. Las páginas procesadas se conservaron.": "The audit failed. Processed pages have been retained.",
  "Auditoría interrumpida al reiniciar la aplicación. Las páginas procesadas se conservaron.": "Audit interrupted when the application restarted. Processed pages have been retained.",
  "El proceso se cerró antes de terminar la auditoría.": "The process stopped before the audit finished.",
  "El análisis se interrumpió al reiniciar el servidor. Los resultados parciales se conservaron.": "The audit was interrupted when the server restarted. Partial results were retained.",
  "La solicitud falló sin una respuesta HTTP verificable.": "The request failed without a verifiable HTTP response.",
  "JSON inválido": "Invalid JSON",
};
const schemaDetails: Readonly<Record<string, string>> = {
  "se esperaba un objeto JSON-LD.": "expected a JSON-LD object.",
  "falta @context; revisar si es un documento JSON-LD completo.": "missing @context; check whether this is a complete JSON-LD document.",
  "falta @type o @graph.": "missing @type or @graph.",
  "@type debe contener nombres de tipos.": "@type must contain type names.",
  "la propiedad url no contiene una URL HTTP válida.": "the url property does not contain a valid HTTP URL.",
};

type LegacyRule = readonly [RegExp, (match: RegExpMatchArray) => string];
const rules: readonly LegacyRule[] = [
  [/^Revisadas (\d+) de hasta (\d+) URLs…$/, m => `Checked ${m[1]} of up to ${m[2]} URLs…`],
  [/^Se alcanzó el límite de (\d+) páginas\. Las conclusiones se refieren a la muestra analizada\.$/, m => `The limit of ${m[1]} pages was reached. Findings apply to the analyzed sample.`],
  [/^Tamaños de imágenes: hasta (\d+) URLs internas únicas mediante HEAD\. Sin Content-Length no se estima el peso\.$/, m => `Image sizes: up to ${m[1]} unique internal URLs using HEAD. Size is not estimated without Content-Length.`],
  [/^robots\.txt respondió HTTP (\d+); rastreo suspendido para este origen\.$/, m => `robots.txt returned HTTP ${m[1]}; crawling suspended for this origin.`],
  [/^La respuesta (descomprimida )?excede el límite de (\d+) bytes\.$/, m => `The ${m[1] ? "decompressed " : ""}response exceeds the limit of ${m[2]} bytes.`],
  [/^Timeout de solicitud \((\d+) ms\)\.$/, m => `Request timed out (${m[1]} ms).`],
  [/^Sitemap externo omitido: (.+)$/, m => `External sitemap skipped: ${m[1]}`],
  [/^Sitemap incompleto o no accesible: ([\s\S]+)$/, m => `Sitemap incomplete or inaccessible: ${translateLegacyMessage(m[1])}`],
  [/^HTTP (\d+) en (HEAD|https?:\/\/\S+)$/, m => `HTTP ${m[1]} ${m[2] === "HEAD" ? "in HEAD" : `at ${m[2]}`}`],
  [/^HTTP (\d+); destino: (.+)$/, m => `HTTP ${m[1]}; destination: ${m[2]}`],
  [/^(\d+) saltos; destino: (.+)$/, m => `${m[1]} hops; destination: ${m[2]}`],
  [/^(\d+) saltos → (.+)$/, m => `${m[1]} hops → ${m[2]}`],
  [/^(.+) → (.+) \((\d+) saltos\)\.$/, m => `${m[1]} → ${m[2]} (${m[3]} hops).`],
  [/^(\d+) caracteres: ([\s\S]*)$/, m => `${m[1]} characters: ${m[2]}`],
  [/^(\d+) páginas con el mismo (title|description): ([\s\S]*)$/, m => `${m[1]} pages with the same ${m[2]}: ${m[3]}`],
  [/^(\d+) elementos H1; ninguno con texto\.$/, m => `${m[1]} H1 elements; none contain text.`],
  [/^(\d+) elementos H1: ([\s\S]*)$/, m => `${m[1]} H1 elements: ${m[2]}`],
  [/^(\d+) headings vacíos: ([\s\S]*)$/, m => `${m[1]} empty headings: ${m[2]}`],
  [/^(Inicio|H[1-6]) → (H[1-6]): ([\s\S]*)$/, m => `${m[1] === "Inicio" ? "Start" : m[1]} → ${m[2]}: ${m[3] === "(vacío)" ? "(empty)" : m[3]}`],
  [/^(\d+) palabras aproximadas en HTML; no se renderizó JavaScript\.$/, m => `${m[1]} approximate words in HTML; JavaScript was not rendered.`],
  [/^(\d+) páginas con texto normalizado idéntico; hash (\w+); (\d+) palabras\.$/, m => `${m[1]} pages with identical normalized text; hash ${m[2]}; ${m[3]} words.`],
  [/^Imagen sin atributo alt: (.+)$/, m => `Image missing alt attribute: ${m[1]}`],
  [/^Alt vacío: (.+); puede ser una imagen decorativa\.$/, m => `Empty alt: ${m[1]}; this may be a decorative image.`],
  [/^Campos faltantes o vacíos: (.+)$/, m => `Missing or empty fields: ${m[1]}`],
  [/^Directivas aplicables a Googlebot \(genéricas \+ específicas\): (.+)$/, m => `Directives applicable to Googlebot (generic + specific): ${m[1].replace(/(meta|header), todos los bots:/g, "$1, all bots:")}`],
  [/^Directivas (?:aplicables a Googlebot|detectadas): (.*)$/, m => `Directives applicable to Googlebot: ${m[1]}`],
  [/^Reglas de (.+); no se solicitó el HTML\.$/, m => `Rules from ${m[1]}; HTML was not requested.`],
  [/^Política de (.+) para SiteInspectorBot; no se solicitó el HTML bloqueado\.$/, m => `Policy from ${m[1]} for SiteInspectorBot; blocked HTML was not requested.`],
  [/^(\d+) etiquetas; href: ([\s\S]*)$/, m => `${m[1]} tags; href: ${m[2] === "ausente" ? "missing" : m[2]}`],
  [/^Canonical fuera del dominio: (.+)\. Puede ser intencional; revisar equivalencia\.$/, m => `Canonical outside the site domain: ${m[1]}. This may be intentional; review content equivalence.`],
  [/^Canonical (.+): HTTP (.+), noindex=(.+), robots=(.+), error=([\s\S]*)\.$/, m => `Canonical ${m[1]}: HTTP ${m[2] === "no verificado" ? "unverified" : m[2]}, noindex=${m[3] === "desconocido" ? "unknown" : m[3]}, robots=${m[4]}, error=${m[5] === "ninguno" ? "none" : translateLegacyMessage(m[5])}.`],
  [/^Política evaluada para Googlebot en (.+)\. Acceso de rastreo denegado; no confirma el estado en el índice\.$/, m => `Policy evaluated for Googlebot at ${m[1]}. Crawl access denied; this does not confirm indexing state.`],
  [/^Enlace a (.+); respuesta HTTP (\d+); texto: ([\s\S]*)\.$/, m => `Link to ${m[1]}; HTTP ${m[2]}; text: ${m[3] === "(vacío)" ? "(empty)" : m[3]}.`],
  [/^Enlace a (.+); solicitud fallida: ([\s\S]*)\. No confirma un enlace roto\.$/, m => `Link to ${m[1]}; request failed: ${translateLegacyMessage(m[2])}. This does not confirm a broken link.`],
  [/^Profundidad observada: (\d+); inicio (.+)\.$/, m => `Observed depth: ${m[1]}; start ${m[2]}.`],
  [/^HTTP (\d+) observado\.$/, m => `HTTP ${m[1]} observed.`],
  [/^Documentos consultados: (.*?)\. ([\s\S]*)$/, m => `Documents checked: ${m[1] === "ninguno utilizable" ? "none usable" : m[1]}. ${translateLegacyMessage(m[2])}`],
  [/^Muestra: (\d+)\/(\d+) páginas máximas; sitemap (truncado|leído); navegación sin JavaScript\. No confirma orfandad\.$/, m => `Sample: ${m[1]}/${m[2]} maximum pages; sitemap ${m[3] === "truncado" ? "truncated" : "read"}; navigation without JavaScript. This does not confirm orphan status.`],
  [/^URL de sitemap sin enlaces internos observados\. ([\s\S]*)$/, m => `Sitemap URL without observed internal links. ${translateLegacyMessage(m[1])}`],
  [/^Página descargada desde sitemap\. ([\s\S]*)$/, m => `Page downloaded from sitemap. ${translateLegacyMessage(m[1])}`],
  [/^URL declarada en sitemap; contenido no verificado\. ([\s\S]*)$/, m => `URL listed in sitemap; content unverified. ${translateLegacyMessage(m[1])}`],
  [/^URL indexable observada: (.+); no encontrada en (\d+) documentos leídos\.( Sitemap truncado: comparación parcial\.)?$/, m => `Observed URL estimated to be indexable: ${m[1]}; not found in ${m[2]} documents read.${m[3] ? " Sitemap truncated: partial comparison." : ""}`],
  [/^Patrones reconocidos en HTML: (.+)\. No se ejecutaron scripts\.$/, m => `Patterns recognized in HTML: ${m[1]}. Scripts were not executed.`],
  [/^Bloque (\d+)([^:]*): ([\s\S]*)$/, m => {
    const detail = schemaDetails[m[3]] ?? (m[3].startsWith("@id repetido con propiedades diferentes: ") ? `repeated @id with different properties: ${m[3].slice("@id repetido con propiedades diferentes: ".length)}` : translateLegacyMessage(m[3]));
    return `Block ${m[1]}${m[2]}: ${detail}`;
  }],
];

/**
 * Read-only English overlay for known application-authored legacy diagnostics.
 * Never pass page titles, descriptions, headings, content, link text or source bodies here.
 * Dynamic website content inside known evidence templates is preserved verbatim.
 */
export function translateLegacyMessage(text: string): string {
  if (Object.prototype.hasOwnProperty.call(exact, text)) return exact[text];
  for (const [pattern, translate] of rules) {
    const match = text.match(pattern);
    if (match) return translate(match);
  }
  if (text.includes("\n")) return text.split("\n").map(translateLegacyMessage).join("\n");
  const status = text.match(/^([\s\S]*); último status recibido: (.+)$/);
  if (status) return `${translateLegacyMessage(status[1])}; last received status: ${status[2] === "sin respuesta HTTP" ? "no HTTP response" : status[2]}`;
  const wrapped = text.match(/^(https?:\/\/\S+): ([\s\S]+)$/);
  if (wrapped) return `${wrapped[1]}: ${translateLegacyMessage(wrapped[2])}`;
  return text;
}
