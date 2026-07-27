import { chromium } from "playwright";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 1);

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});

await page.goto(
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=${pageNo}`,
  { waitUntil: "domcontentloaded", timeout: 60_000 }
);
await page.waitForTimeout(7000);

const info = await page.evaluate(() => {
  const d = window.data || {};
  const offer = d.offerV2Showed?.offerList?.[0] || {};
  return {
    offerresultData: d.offerresultData,
    pageConfigData: d.pageConfigData,
    requestData: d.requestData,
    offerV2Keys: d.offerV2 ? Object.keys(d.offerV2) : [],
    offerV2ResponseKeys: d.offerV2?.response ? Object.keys(d.offerV2.response) : [],
    offerV2DataKeys: d.offerV2?.response?.data ? Object.keys(d.offerV2.response.data) : [],
    offerV2ShowedKeys: d.offerV2Showed ? Object.keys(d.offerV2Showed) : [],
    sampleOffer: {
      offerId: offer.offerId,
      title: offer.title,
      priceInfo: offer.priceInfo,
      bookedCount: offer.bookedCount,
      offerPicUrl: offer.offerPicUrl,
      odPicUrl: offer.odPicUrl,
      linkUrl: offer.linkUrl,
      company: offer.company || offer.shop,
      shop: offer.shop,
      loginId: offer.loginId,
      province: offer.province,
      city: offer.city,
      tags: offer.tags,
      quantityBegin: offer.quantityBegin,
      tradeQuantity: offer.tradeQuantity,
      tradeScale: offer.tradeScale,
      repurchaseRate: offer.offerRepurchaseRate || offer.repurchaseRate,
    },
  };
});

console.log(JSON.stringify(info, null, 2).slice(0, 8000));
await browser.close();
