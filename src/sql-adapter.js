function translateSql(sql, postgresMode = true) {
  let translated = sql.trim();
  if (postgresMode) {
    translated = translated
      .replace(
        /GROUP_CONCAT\(sub_ministries\.name,\s*',\s*'\)/gi,
        "STRING_AGG(sub_ministries.name, ', ' ORDER BY sub_ministries.name)"
      )
      .replace(/\n\s*ORDER BY sub_ministries\.name/gi, "")
      .replace(/MAX\(present,\s*excluded\.present\)/gi, "GREATEST(present, excluded.present)");
  }
  const ignoreInsert = /^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(translated);
  if (ignoreInsert) {
    translated = translated.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
    translated = `${translated.replace(/;$/, "")} ON CONFLICT DO NOTHING`;
  }
  let index = 0;
  return translated.replace(/\?/g, () => `$${++index}`);
}

module.exports = { translateSql };
