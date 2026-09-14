function normalizePhone(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[()\-+]/g, "")
    .replace(/[^\d]/g, "")
    .trim();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNameKey(value) {
  return normalizeName(value).replace(/\s+/g, "");
}

function levenshteinDistance(left, right) {
  if (left === right) {
    return 0;
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function areLikelyNameMatches(firstName, secondName) {
  if (!firstName || !secondName) {
    return false;
  }

  const left = normalizeNameKey(firstName);
  const right = normalizeNameKey(secondName);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const firstWords = left.split(" ");
  const secondWords = right.split(" ");
  if (firstWords.length > 1 && secondWords.length > 1) {
    const leftLast = firstWords[firstWords.length - 1];
    const rightLast = secondWords[secondWords.length - 1];
    const lastNameDistance = levenshteinDistance(leftLast, rightLast);
    if (leftLast === rightLast) {
      return true;
    }
    if (lastNameDistance <= 2) {
      return true;
    }
  }

  return levenshteinDistance(left, right) <= 2;
}

function isValidBirthDate(day, month) {
  if (!Number.isInteger(day) || !Number.isInteger(month)) {
    return false;
  }

  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return false;
  }

  const monthDayLimits = {
    1: 31,
    2: 29,
    3: 31,
    4: 30,
    5: 31,
    6: 30,
    7: 31,
    8: 31,
    9: 30,
    10: 31,
    11: 30,
    12: 31,
  };

  return day <= monthDayLimits[month];
}

module.exports = {
  areLikelyNameMatches,
  isValidBirthDate,
  normalizeName,
  normalizeNameKey,
  normalizePhone,
};
