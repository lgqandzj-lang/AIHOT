// Fixed synthetic provider responses. Offline tests never request external services.
export const fixtureDoi = '10.9999/varipulse-metadata-fixture';
export const fixturePmid = '90000001';
export const crossrefResponse = {
  message: {
    DOI: fixtureDoi,
    title: ['[SYNTHETIC] VARIPULSE metadata fixture'],
    author: [{ given: 'Test', family: 'Author' }],
    'container-title': ['Example Electrophysiology Journal'],
    'published-online': { 'date-parts': [[2025, 10, 23]] },
    deposited: { 'date-time': '2025-10-24T10:00:00Z' },
  },
};
export const pubmedResponse = `<?xml version="1.0" encoding="UTF-8"?>
<PubmedArticleSet><PubmedArticle>
  <MedlineCitation><PMID Version="1">${fixturePmid}</PMID>
    <DateRevised><Year>2025</Year><Month>11</Month><Day>04</Day></DateRevised>
    <Article>
      <Journal><JournalIssue><PubDate><Year>2025</Year><Month>Oct</Month><Day>23</Day></PubDate></JournalIssue><Title>Example Electrophysiology Journal</Title></Journal>
      <ArticleTitle>[SYNTHETIC] VARIPULSE&#x2122; metadata fixture</ArticleTitle>
      <Abstract><AbstractText Label="Background">Fixed abstract text for offline testing.</AbstractText></Abstract>
      <AuthorList><Author><LastName>Author</LastName><ForeName>Test</ForeName></Author></AuthorList>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="pubmed">${fixturePmid}</ArticleId><ArticleId IdType="doi">${fixtureDoi}</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle></PubmedArticleSet>`;
