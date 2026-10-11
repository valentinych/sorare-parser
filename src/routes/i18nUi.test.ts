import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

function parseI18nRows(src: string) {
  const start = src.indexOf("const rows = [");
  const end = src.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start, "i18n rows array");
  const body = src.slice(start, end + 3);
  const rows: string[][] = [];
  const re =
    /\[\s*"((?:\\.|[^"\\])*)"\s*,\s*"((?:\\.|[^"\\])*)"\s*,\s*"((?:\\.|[^"\\])*)"\s*,\s*"((?:\\.|[^"\\])*)"\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    rows.push(match.slice(1, 5).map((part) => JSON.parse(`"${part}"`)));
  }
  return rows;
}

test("i18n rows have four locales and cover new Builder/Premium/Tables/Doma copy", async () => {
  const src = await readFile(new URL("../../public-tm/i18n.js", import.meta.url), "utf8");
  const rows = parseI18nRows(src);
  assert.ok(rows.length > 700, `expected many i18n rows, got ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.length, 4, row[0]);
    for (const cell of row) {
      assert.equal(typeof cell, "string");
      assert.ok(cell.length > 0, `empty locale in ${row[0]}`);
    }
  }

  const byRu = new Map(rows.map((row) => [row[0], row]));
  const required: Array<[string, string, string, string]> = [
    ["Обновить после раундов аукциона", "Refresh after auction rounds", "Оновити після раундів аукціону", "Абнавіць пасля раундаў аўкцыёну"],
    ["Обновить статус после рассчитанных раундов аукциона", "Refresh status after calculated auction rounds", "Оновити статус після розрахованих раундів аукціону", "Абнавіць статус пасля разлічаных раундаў аўкцыёну"],
    ["Обновляю аукцион выбранной лиги…", "Refreshing the selected league auction…", "Оновлюю аукціон вибраної ліги…", "Абнаўляю аўкцыён выбранай лігі…"],
    ["Топ-5 свободных", "Top 5 unpicked", "Топ-5 вільних", "Топ-5 вольных"],
    ["Сгенерировать состав", "Generate squad", "Згенерувати склад", "Згенераваць склад"],
    ["Никто не выбран", "None selected", "Нікого не обрано", "Ніхто не выбраны"],
    ["Отчёт по составу", "Squad report", "Звіт по складу", "Справаздача па складзе"],
    ["% к идеалу", "% of ideal", "% до ідеалу", "% да ідэалу"],
    ["Ideal TS", "Ideal TS", "Ideal TS", "Ideal TS"],
    ["счёт Mantra неизвестен", "Mantra score unknown", "рахунок Mantra невідомий", "лік Mantra невядомы"],
    ["Открыть фото", "Open photo", "Відкрити фото", "Адкрыць фота"],
    ["Минуты за сезон", "Minutes this season", "Хвилини за сезон", "Хвіліны за сезон"],
    ["Пропущенные голы", "Goals conceded", "Пропущені голи", "Прапушчаныя галы"],
    ["Отчёты", "Reports", "Звіти", "Справаздачы"],
    ["Обновить снимок", "Refresh snapshot", "Оновити знімок", "Абнавіць здымак"],
    ["футмопс", "footmops", "футмопс", "футмопс"],
    ["Лига 1", "Ligue 1", "Ліга 1", "Ліга 1"],
    ["Ла Лига", "La Liga", "Ла Ліга", "Ла Ліга"],
    ["Эредивизи", "Eredivisie", "Ередивізі", "Эрэдывізі"],
    ["Про-лига", "Pro League", "Про-ліга", "Про-ліга"],
    ["Примейра-лига", "Primeira Liga", "Прімейра-ліга", "Прымэйра-ліга"],
    ["УПЛ", "UPL", "УПЛ", "УПЛ"],
    ["MLS", "MLS", "MLS", "MLS"],
    ["Бразилейран", "Brasileirão", "Бразилейран", "Бразілейран"],
    ["League One", "League One", "League One", "League One"],
  ];
  for (const [ru, en, uk, be] of required) {
    const row = byRu.get(ru);
    assert.ok(row, `missing i18n key: ${ru}`);
    assert.deepEqual(row, [ru, en, uk, be]);
  }

  assert.match(src, /Available in \$\{match\[1\]\} min/);
  assert.match(src, /Доступно через \$\{match\[1\]\} хв/);
  assert.match(src, /Даступна праз \$\{match\[1\]\} хв/);
  assert.match(src, /справочник\|справочника\|справочников/);
});
