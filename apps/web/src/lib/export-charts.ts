import "server-only";
import AdmZip from "adm-zip";

/**
 * ExcelJS cannot create charts, so the statistics sheet's two bar charts are
 * injected into the finished .xlsx package afterwards: this module appends the
 * chart parts, the drawing anchor and all required relationships.
 *
 * Values are written as cached points (like a saved workbook), so the charts
 * render in every viewer immediately, without a recalculation pass.
 */

export interface ChartSeries {
  /** Series name shown in the legend. */
  name: string;
  /** Formula-style reference for the series name cell, e.g. "'آمار'!$H$7". */
  nameRef: string;
  /** Formula-style reference for the values range, e.g. "'آمار'!$H$8:$H$25". */
  valueRef: string;
  values: number[];
  /** 6-digit hex color of the bars. */
  color: string;
  /** When set, negative values get this color via per-point overrides. */
  negativeColor?: string;
}

export interface ChartSpec {
  title: string;
  /** Formula-style reference for the categories range, e.g. "'آمار'!$C$8:$C$25". */
  categoryRef: string;
  categories: string[];
  series: ChartSeries[];
  /** Bar gap width; poker-style compact bars use 50-80. */
  gapWidth?: number;
  /** Show the legend below the plot. */
  legend?: boolean;
}

export interface ChartAnchor {
  /** 0-based column of the top-left corner. */
  col: number;
  /** 0-based row of the top-left corner. */
  row: number;
  /** Width in EMU (914400 = 1 inch). */
  width: number;
  /** Height in EMU. */
  height: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

function cachePoints(values: number[]): string {
  return values.map((v, i) => `<c:pt idx="${i}"><c:v>${num(v)}</c:v></c:pt>`).join("");
}

function strPoints(values: string[]): string {
  return values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("");
}

/** Build a complete c:chartSpace document for one bar chart. */
export function chartXml(spec: ChartSpec, lang: string): string {
  const series = spec.series
    .map((s, i) => {
      const dpts =
        s.negativeColor && s.values.some((v) => v < 0)
          ? s.values
              .map((v, idx) => (v < 0 ? idx : -1))
              .filter((idx) => idx >= 0)
              .map(
                (idx) =>
                  `<c:dPt><c:idx val="${idx}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${s.negativeColor}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${s.negativeColor}"/></a:solidFill></a:ln></c:spPr></c:dPt>`,
              )
              .join("")
          : "";
      return (
        `<c:ser>` +
        `<c:idx val="${i}"/><c:order val="${i}"/>` +
        `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:prstDash val="solid"/></a:ln></c:spPr>` +
        `<c:invertIfNegative val="0"/>` +
        dpts +
        `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` +
        `<c:cat><c:strRef><c:f>${esc(spec.categoryRef)}</c:f><c:strCache><c:ptCount val="${spec.categories.length}"/>${strPoints(spec.categories)}</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>${esc(s.valueRef)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${s.values.length}"/>${cachePoints(s.values)}</c:numCache></c:numRef></c:val>` +
        `</c:ser>`
      );
    })
    .join("");

  const overlap = spec.series.length > 1 ? `<c:overlap val="0"/>` : "";
  const legend = spec.legend
    ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="${esc(lang)}"/></a:p></c:txPr></c:legend>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:date1904 val="0"/><c:lang val="${esc(lang)}"/><c:roundedCorners val="1"/>` +
    `<c:chart>` +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"/></a:pPr><a:r><a:rPr lang="${esc(lang)}" sz="1100" b="1"/><a:t>${esc(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
    `<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>` +
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
    series +
    `<c:gapWidth val="${spec.gapWidth ?? 60}"/>${overlap}` +
    `<c:axId val="10"/><c:axId val="100"/></c:barChart>` +
    `<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="${esc(lang)}"/></a:p></c:txPr><c:crossAx val="100"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="1"/></c:catAx>` +
    `<c:valAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>` +
    `</c:plotArea>` +
    legend +
    `<c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="1"/>` +
    `</c:chart>` +
    `<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>` +
    `</c:chartSpace>`
  );
}

function anchorXml(anchor: ChartAnchor, relId: string, chartId: number): string {
  return (
    `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${anchor.width}" cy="${anchor.height}"/>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${chartId}" name="Chart ${chartId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`
  );
}

/**
 * Append charts to a finished xlsx buffer, anchored on the given worksheet.
 * Returns the new buffer. When `charts` is empty the input is returned as-is.
 */
export function appendCharts(
  xlsx: Buffer,
  sheetName: string,
  lang: string,
  charts: { spec: ChartSpec; anchor: ChartAnchor }[],
): Buffer {
  if (charts.length === 0) return xlsx;

  const zip = new AdmZip(xlsx);
  const read = (name: string) => zip.getEntry(name)?.getData().toString("utf8");

  // Map the sheet name to its part path via workbook.xml + its rels.
  const workbookXml = read("xl/workbook.xml");
  const workbookRels = read("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !workbookRels) throw new Error("workbook parts missing");

  const escaped = sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sheetMatch = workbookXml.match(new RegExp(`<sheet[^>]*name="${escaped}"[^>]*r:id="(rId\\d+)"`));
  if (!sheetMatch) throw new Error(`sheet ${sheetName} not found in workbook.xml`);
  const sheetRid = sheetMatch[1]!;
  const relMatch = workbookRels.match(new RegExp(`Id="${sheetRid}"[^>]*Target="([^"]+)"`));
  if (!relMatch) throw new Error(`relationship ${sheetRid} not found`);
  const sheetPath = `xl/${relMatch[1]!.replace(/^\//, "")}`; // Target is relative to xl/
  const sheetRelsPath = sheetPath.replace(/worksheets\//, "worksheets/_rels/") + ".rels";

  // Chart parts.
  charts.forEach((c, i) => {
    zip.addFile(`xl/charts/chart${i + 1}.xml`, Buffer.from(chartXml(c.spec, lang), "utf8"));
  });

  // Drawing part with one anchor per chart.
  const drawingBody = charts
    .map((c, i) => anchorXml(c.anchor, `rId${i + 1}`, i + 2))
    .join("");
  const drawingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${drawingBody}</xdr:wsDr>`;
  const drawingPath = "xl/drawings/drawing1.xml";
  const drawingRelsPath = "xl/drawings/_rels/drawing1.xml.rels";
  zip.addFile(drawingPath, Buffer.from(drawingXml, "utf8"));

  const drawingRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    charts
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i + 1}.xml"/>`,
      )
      .join("") +
    `</Relationships>`;
  zip.addFile(drawingRelsPath, Buffer.from(drawingRels, "utf8"));

  // Worksheet rels: point rId at the drawing.
  const existingRels = read(sheetRelsPath);
  let drawingRid = "rId1";
  if (existingRels) {
    const ids = [...existingRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    drawingRid = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    const updated = existingRels.replace(
      "</Relationships>",
      `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    );
    zip.getEntry(sheetRelsPath)?.setData(Buffer.from(updated, "utf8"));
  } else {
    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` +
      `</Relationships>`;
    zip.addFile(sheetRelsPath, Buffer.from(rels, "utf8"));
  }

  // Reference the drawing from the worksheet XML (drawing comes after pageSetup).
  const sheetXml = read(sheetPath);
  if (!sheetXml) throw new Error(`sheet part ${sheetPath} missing`);
  if (!/<drawing[^>]/.test(sheetXml)) {
    const updated = sheetXml.replace(/<\/worksheet>/, `<drawing r:id="${drawingRid}"/></worksheet>`);
    zip.getEntry(sheetPath)?.setData(Buffer.from(updated, "utf8"));
  }

  // Content types: declare the new parts.
  const contentTypes = read("[Content_Types].xml");
  if (!contentTypes) throw new Error("[Content_Types].xml missing");
  let overrides = "";
  charts.forEach((_, i) => {
    overrides += `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`;
  });
  overrides += `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
  zip.getEntry("[Content_Types].xml")?.setData(Buffer.from(contentTypes.replace("</Types>", `${overrides}</Types>`), "utf8"));

  return zip.toBuffer();
}
