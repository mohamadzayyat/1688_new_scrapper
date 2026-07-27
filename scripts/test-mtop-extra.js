import assert from "node:assert/strict";
import { findMobileShippingData, mapMobileShipping } from "../mobileShipping.js";
import {
  buildImageSearchData,
  imageSortParams,
  mapImageOffer,
  mapMobileFreightResponse,
  mapMtopReview,
  provinceIdentity,
  reviewBatchPlan,
  uniqueImageOffers,
} from "../mtopExtra.js";

const OFFER_ID = "874039857500";

const wrongOfferShipping = {
  offerId: "999999999999",
  location: "wrong origin",
  logistics: "wrong logistics",
  deliveryLimitTxt: "wrong delivery",
  deliveryLimit: "99",
  sendAddressCode: "wrong-code",
  targetLocation: "wrong target",
  amount: "99",
  templateId: "wrong-template",
  unitWeight: "99",
  postFeeValue: "99",
  postFree: false,
  skuWeight: { wrong: "99" },
};

const offerShipping = {
  offerId: OFFER_ID,
  location: "浙江金华",
  logistics: "48小时内发货",
  deliveryLimitTxt: "48小时内发货",
  deliveryLimit: "48",
  sendAddressCode: "330700",
  targetLocation: "广东省",
  amount: "2",
  templateId: "554329111",
  unitWeight: "0.35",
  postFeeValue: "4",
  postFree: false,
  skuWeight: { red: "0.4", blue: "0.5" },
};

const mobileInit = {
  data: {
    101: { data: wrongOfferShipping },
    9837421: { children: [{ data: offerShipping }] },
  },
  globalData: {
    channelType: "dsc",
    skuModel: {
      extraInfo: {
        freightInfo: {
          sellerUserId: "2218225422038",
          freeEndAmount: "-1",
          officialLogistics: true,
          sendAddressCode: "330700",
          templateId: "554329111",
          unitWeight: "0.35",
        },
      },
    },
  },
};

assert.equal(
  findMobileShippingData(mobileInit, OFFER_ID),
  offerShipping,
  "shipping discovery must be tied to the requested offer identity"
);
const shipping = mapMobileShipping(mobileInit, OFFER_ID);
assert.equal(shipping.location, "浙江金华");
assert.equal(shipping.targetLocation, "广东省");
assert.equal(shipping.postFeeValue, 4);
assert.equal(shipping.totalCost, 4);
assert.equal(shipping.templateId, "554329111");
assert.equal(shipping.unitWeight, 0.35);
assert.equal(shipping.sellerUserId, "2218225422038");
assert.equal(shipping.officialLogistics, true);
assert.equal(shipping.pageScene, "dsc");

const explicitFree = {
  ...offerShipping,
  postFree: true,
  postFeeValue: undefined,
};
assert.equal(
  mapMobileShipping({ nested: explicitFree }, OFFER_ID).postFeeValue,
  0,
  "an explicit free-shipping flag may produce a zero quote"
);
const explicitZero = { ...offerShipping, postFeeValue: "0" };
assert.equal(mapMobileShipping({ nested: explicitZero }, OFFER_ID).postFeeValue, 0);
const missingFee = {
  ...offerShipping,
  postFeeValue: undefined,
  totalCost: undefined,
  freightInfo: undefined,
};
assert.equal(
  mapMobileShipping({ nested: missingFee }, OFFER_ID),
  null,
  "a missing fee must never be converted to free shipping"
);

const freight = mapMobileFreightResponse(
  OFFER_ID,
  { shipping, tempModel: { offerUnit: "件" } },
  { total_quantity: 2 }
);
assert.equal(freight.code, 200);
assert.equal(freight.data.total_fee, 4);
assert.equal(freight.data.total_quantity, 2);
assert.equal(freight.data.total_weight, 0.7);
assert.equal(freight.data.shipping_to, "广东省");
assert.equal(freight.data.location_from, "浙江金华");
assert.equal(freight.data.quote_scope, "offer_default");
assert.equal(freight.data.quote_matches_requested_quantity, true);
assert.equal(freight.data.fee_scaled_for_quantity, false);
assert.throws(
  () =>
    mapMobileFreightResponse(
      OFFER_ID,
      { shipping: { ...shipping, amount: 1 } },
      { total_quantity: 2 }
    ),
  /does not match the requested quantity/
);
const aliasedFreight = mapMobileFreightResponse(
  OFFER_ID,
  { shipping },
  { province: "Guangdong", total_quantity: 2 }
);
assert.equal(aliasedFreight.code, 200);
assert.equal(aliasedFreight.data.shipping_to, "广东省");
assert.deepEqual(provinceIdentity("Guangdong Province"), {
  code: "440000",
  name: "广东",
});
assert.deepEqual(provinceIdentity("广东省"), {
  code: "440000",
  name: "广东",
});
assert.throws(
  () => mapMobileFreightResponse(OFFER_ID, { shipping }, { province: "浙江" }),
  (error) => error?.tmapiCode === 422 && /does not match/.test(error.message)
);
assert.throws(
  () => mapMobileFreightResponse(OFFER_ID, { shipping }, { total_weight: 1.2 }),
  (error) => error?.tmapiCode === 422 && /Custom-weight/.test(error.message)
);

const review = mapMtopReview(
  {
    id: "review-1",
    itemId: OFFER_ID,
    content: "  很好，发货快  ",
    gmtPublished: "2026-07-20 11:22:33",
    starLevel: "5",
    raterUserNick: "buyer***",
    raterLevel: "L2",
    quantity: "2",
    unit: "件",
    specInfo: "颜色#3B红色#3A尺码#3B大",
    feedBackAddress: "广东",
    isSystemRemark: false,
    imageList: [{ imageUrl: "//cbu01.alicdn.com/img/review.jpg" }],
  },
  OFFER_ID
);
assert.equal(review.id, "review-1");
assert.equal(review.content, "很好，发货快");
assert.equal(review.date, "2026-07-20 11:22:33");
assert.equal(review.rating, 5);
assert.equal(review.user_nick, "buyer***");
assert.equal(review.quantity, 2);
assert.equal(review.sku_info, "颜色=红色; 尺码=大");
assert.deepEqual(review.images, ["https://cbu01.alicdn.com/img/review.jpg"]);
assert.deepEqual(reviewBatchPlan(1, 20), {
  offset: 0,
  withinBatch: 0,
  upstreamIndexes: [1, 3],
});
assert.deepEqual(reviewBatchPlan(2, 20), {
  offset: 20,
  withinBatch: 0,
  upstreamIndexes: [5, 7],
});
assert.deepEqual(reviewBatchPlan(2, 10), {
  offset: 10,
  withinBatch: 0,
  upstreamIndexes: [3],
});

const fixtureImage =
  "https://cbu01.alicdn.com/img/ibank/O1CN01PNSFLg1QvSKjy2TvZ_!!2218225422038-0-cib.jpg";
const pageOneParams = JSON.parse(
  buildImageSearchData(fixtureImage, 1, 10, "sales").params
);
const pageTwoParams = JSON.parse(
  buildImageSearchData(fixtureImage, 2, 10, "price_asc").params
);
assert.equal(pageOneParams.imageAddress, fixtureImage);
assert.equal(pageOneParams.pageIndex, "1");
assert.equal(pageOneParams.pageSize, "10");
assert.equal(pageOneParams.sortField, "total_sales_volume");
assert.equal(pageOneParams.sortType, "desc");
assert.equal(pageTwoParams.pageIndex, "2");
assert.equal(pageTwoParams.sortField, "price");
assert.equal(pageTwoParams.sortType, "asc");
assert.deepEqual(imageSortParams("price_desc"), {
  sortField: "price",
  sortType: "desc",
});

const imageOffer = mapImageOffer({
  id: OFFER_ID,
  subject: "人体工学扶手",
  odPicUrl: "//cbu01.alicdn.com/img/test-offer.jpg",
  priceInfo: { price: "12.50" },
  companyName: "Test Factory",
  province: "浙江",
  city: "金华",
  memberId: "b2b-test",
  loginId: "seller-login",
  saleQuantityDescription: "1000+件",
  freePostage: "true",
});
assert.equal(imageOffer.offerId, OFFER_ID);
assert.equal(imageOffer.title, "人体工学扶手");
assert.equal(imageOffer.price, "12.5");
assert.equal(imageOffer.image, "https://cbu01.alicdn.com/img/test-offer.jpg");
assert.equal(imageOffer.company, "Test Factory");
assert.equal(imageOffer.free_postage, true);
const imageRow = (id) => ({
  id: String(id),
  subject: `offer ${id}`,
  odPicUrl: `https://cbu01.alicdn.com/img/${id}.jpg`,
  priceInfo: { price: "1" },
});
const uniqueImageStream = uniqueImageOffers([
  [imageRow(1), imageRow(2)],
  [imageRow(2), imageRow(3)],
]);
assert.deepEqual(
  uniqueImageStream.map((item) => item.offerId),
  ["1", "2", "3"],
  "raw image-page boundary duplicates must be removed globally"
);

console.log("mtop extra tests passed");
