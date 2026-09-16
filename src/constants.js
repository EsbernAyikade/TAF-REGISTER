const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const LOVE_FELLOWSHIPS = [
  { name: "Gaza Love Fellowship", slug: "gaza-love-fellowship" },
  { name: "Main Campus Love Fellowship", slug: "main-campus-love-fellowship" },
  { name: "Off Campus Love Fellowship", slug: "off-campus-love-fellowship" },
  { name: "Kotei Love Fellowship", slug: "kotei-love-fellowship" },
  { name: "Ayeduase Love Fellowship", slug: "ayeduase-love-fellowship" },
  { name: "Brunei Love Fellowship", slug: "brunei-love-fellowship" },
];

const SUB_MINISTRIES = ["Aloud Choir", "Aloud Creative", "The Eye", "TAF 01"];

const EXECUTIVE_POSITIONS = ["President", "Secretary"];

const REP_POSITIONS = [
  "Aloud Choir Rep",
  "Aloud Creative Rep",
  "Wafer Rep",
  "The Eye",
  "TAF 1",
  "SOS Rep",
  "J Reach Rep",
  "KKBM Rep",
  "Menilo Rep",
  "Evodia Rep",
  "Aloud Care Rep",
  "Globewide Missions Rep",
  "Bank TAF",
  "Campvista Rep",
];

const DIRECTOR_POSITIONS = [
  "Director of Aloud Choir",
  "Director of Aloud Creative",
  "Director of Wafer",
  "Director of The Eye",
  "Director of TAF 1",
  "Director of SOS",
  "Director of J Reach",
  "Director of KKBM",
  "Director of Menilo",
  "Director of Evodia",
  "Director of Aloud Care",
  "Director of Globewide Missions",
  "Director of Bank TAF",
  "Director of Campvista",
];

const GLOBAL_DIRECTOR_ROLES = [
  {
    roleType: "Director",
    positionName: "RD",
    scopeType: "regional",
    displayName: "RD - Regional Director",
  },
  {
    roleType: "Director",
    positionName: "CD",
    scopeType: "country",
    displayName: "CD - Country Director",
  },
];

const COURSE_OPTIONS = [
  "BSc. Aerospace Engineering",
  "BSc. Agricultural Biotechnology",
  "BSc. Agricultural Engineering",
  "BSc. Agriculture",
  "BSc. Architecture",
  "BSc. Biochemistry",
  "BSc. Biological Sciences",
  "BSc. Biomedical Engineering",
  "BSc. Business Administration",
  "BSc. Chemical Engineering",
  "BSc. Chemistry",
  "BSc. Civil Engineering",
  "BSc. Computer Engineering",
  "BSc. Computer Science",
  "BSc. Construction Technology and Management",
  "BSc. Disability and Rehabilitation Studies",
  "BSc. Economics",
  "BSc. Electrical and Electronic Engineering",
  "BSc. Environmental Science",
  "BSc. Food Science and Technology",
  "BSc. Forest Resources Technology",
  "BSc. Geomatic Engineering",
  "BSc. Hospitality and Tourism Management",
  "BSc. Human Biology (Medicine)",
  "BSc. Industrial Engineering",
  "BSc. Information Technology",
  "BSc. Land Economy",
  "BSc. Logistics and Supply Chain Management",
  "BSc. Mathematics",
  "BSc. Mechanical Engineering",
  "BSc. Meteorology and Climate Science",
  "BSc. Midwifery",
  "BSc. Mining Engineering",
  "BSc. Natural Resources Management",
  "BSc. Nursing",
  "BSc. Packaging Technology",
  "BSc. Petroleum Engineering",
  "BSc. Physics",
  "BSc. Quantity Surveying and Construction Economics",
  "BSc. Real Estate",
  "BSc. Statistics",
  "BSc. Telecommunication Engineering",
  "BSc. Textile Design and Technology",
  "Doctor of Pharmacy",
  "Doctor of Veterinary Medicine",
  "LLB",
];

const MEMBER_STATUSES = ["Active", "Inactive", "Associate"];
const GENDER_OPTIONS = ["Male", "Female"];
const STUDY_LEVELS = ["100", "200", "300", "400", "500", "600"];
const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

function buildRoleSeed(fellowships) {
  const fellowshipRoles = fellowships.flatMap((fellowship) => {
    const executives = EXECUTIVE_POSITIONS.map((positionName) => ({
      roleType: "Executive",
      positionName,
      scopeType: "fellowship",
      displayName: positionName,
      fellowshipSlug: fellowship.slug,
    }));

    const reps = REP_POSITIONS.map((positionName) => ({
      roleType: "Rep",
      positionName,
      scopeType: "fellowship",
      displayName: positionName,
      fellowshipSlug: fellowship.slug,
    }));

    const directors = DIRECTOR_POSITIONS.map((positionName) => ({
      roleType: "Director",
      positionName,
      scopeType: "fellowship",
      displayName: positionName,
      fellowshipSlug: fellowship.slug,
    }));

    return [...executives, ...reps, ...directors];
  });

  return [...fellowshipRoles, ...GLOBAL_DIRECTOR_ROLES];
}

module.exports = {
  APPROVAL_STATUSES,
  COURSE_OPTIONS,
  EXECUTIVE_POSITIONS,
  GENDER_OPTIONS,
  LOVE_FELLOWSHIPS,
  MEMBER_STATUSES,
  MONTHS,
  REP_POSITIONS,
  STUDY_LEVELS,
  SUB_MINISTRIES,
  buildRoleSeed,
};
