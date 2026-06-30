const DEFAULT_STORE = 'MegaValue';

function envStoreConfig() {
  try {
    const parsed = JSON.parse(process.env.TAKEALOT_STORES_JSON || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function apiKeyForStore(storeName) {
  const config = envStoreConfig().find((item) => item && item.name === storeName);
  if (config?.apiKeyEnv && process.env[config.apiKeyEnv]) return process.env[config.apiKeyEnv];
  if (config?.apiKey) return config.apiKey;
  const storeSpecificEnv = `TAKEALOT_API_KEY_${storeName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  if (process.env[storeSpecificEnv]) return process.env[storeSpecificEnv];
  return process.env.TAKEALOT_API_KEY || '';
}

function takealotHeaders(storeName) {
  const apiKey = apiKeyForStore(storeName);
  if (!apiKey) throw new Error(`Store ${storeName} has no Takealot API Key configured`);
  return { Accept: 'application/json', Authorization: `Key ${apiKey}` };
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.offers)) return payload.offers;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = numberValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function skuFor(row) {
  return String(row?.sku ?? row?.seller_sku ?? row?.merchant_sku ?? row?.offer_sku ?? '').trim().toUpperCase();
}

function titleFor(row) {
  return String(row?.title ?? row?.product_title ?? row?.name ?? row?.product_name ?? '').trim();
}

function normalizeVariantTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(bestby|arfast|aicom|megavalue|keepfit|lifon|patpaw)\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(cm|mm|m|pcs?|pieces?|pack|set)\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sharedPrefixLength(a, b) {
  const left = normalizeVariantTitle(a);
  const right = normalizeVariantTitle(b);
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function rowKey(row) {
  return String(row?.offer_id ?? row?.sku ?? row?.barcode ?? JSON.stringify(row)).trim();
}

function isDisabledRow(row) {
  return String(row?.status ?? '').trim().toLowerCase().startsWith('disabled');
}

function sumQuantityAvailable(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + (numberValue(item?.quantity_available ?? item?.quantity ?? item) ?? 0), 0);
  }
  if (value && typeof value === 'object') return numberValue(value.quantity_available ?? value.quantity) ?? 0;
  return numberValue(value) ?? 0;
}

function stockFor(row) {
  const explicit = numberValue(row?.quantity_available ?? row?.stock_quantity ?? row?.available_quantity);
  if (explicit !== null) return explicit;
  return sumQuantityAvailable(row?.leadtime_stock ?? row?.stock ?? row?.inventory);
}

function myPriceFor(row) {
  return positiveNumber(row?.selling_price ?? row?.price ?? row?.offer_price ?? row?.current_price);
}

function samePrice(a, b) {
  return a !== null && b !== null && Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

function hasVariantSuffix(title) {
  const suffix = String(title ?? '').split(' - ').pop()?.trim().toLowerCase() || '';
  if (!suffix) return false;
  if (/\b(black|white|blue|green|red|pink|purple|yellow|orange|grey|gray|brown|beige|natural|walnut|silver|gold|clear)\b/.test(suffix)) return true;
  if (/\b\d+(?:\.\d+)?\s*(cm|mm|m|inch|in|kg|g|l|ml)\b/.test(suffix)) return true;
  return false;
}

function offerUrlFor(row) {
  return String(row?.offer_url ?? row?.canonical_url ?? row?.product_url ?? row?.url ?? '').trim();
}

function tsinFor(row) {
  return String(row?.tsin_id ?? row?.tsin ?? row?.product_id ?? '').trim();
}

function extractPlid(value) {
  const text = String(value ?? '');
  const match = text.match(/PLID(\d+)/i);
  return match ? match[1] : '';
}

function normalizeSeller(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sellerIsKnown(value) {
  const seller = normalizeSeller(value);
  return Boolean(seller && !['unknown', 'buy_box_seller', 'takealot_public_page', '-'].includes(seller));
}

function sameSeller(a, b) {
  return normalizeSeller(a) === normalizeSeller(b);
}

function firstText(...values) {
  for (const value of values) {
    if (value && typeof value === 'object') continue;
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function priceBeforeStoreInOtherOffers(text, storeName) {
  if (!storeName) return null;
  const otherOffersIndex = text.search(/Other Offers/i);
  const searchableText = otherOffersIndex >= 0 ? text.slice(otherOffersIndex) : text;
  const storeIndex = searchableText.toLowerCase().indexOf(storeName.toLowerCase());
  if (storeIndex < 0) return null;
  const beforeStore = searchableText.slice(Math.max(0, storeIndex - 260), storeIndex);
  const matches = Array.from(beforeStore.matchAll(/\bR\s*([0-9][0-9\s,]*(?:\.[0-9]{2})?)\b/g));
  const lastMatch = matches.at(-1);
  return lastMatch ? positiveNumber(lastMatch[1]) : null;
}

function parseRawOffers(rawOffers) {
  if (!Array.isArray(rawOffers)) return [];
  return rawOffers.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const price = positiveNumber(
      item.price
      ?? item.selling_price
      ?? item.offer_price
      ?? item.pretty_price
      ?? item?.prices?.selling_price
      ?? item?.pricing?.selling_price
      ?? item?.pricing?.price,
    );
    if (!price) return [];
    const stockValue = item.in_stock ?? item.stock ?? item.quantity_available ?? item.available;
    const inStock = typeof stockValue === 'boolean'
      ? stockValue
      : !['0', 'false', 'none', 'out_of_stock', 'disabled'].includes(String(stockValue ?? 'true').toLowerCase());
    const sellerDetail = item.seller_detail || item.seller || item.seller_info || item.merchant || item.merchant_detail || {};
    return [{
      seller: firstText(
        item.seller_name,
        item.display_name,
        item.name,
        item.merchant_name,
        sellerDetail.display_name,
        sellerDetail.name,
        sellerDetail.seller_name,
        sellerDetail.trading_name,
      ),
      price,
      inStock,
      isBuyBox: Boolean(item.is_buy_box ?? item.buy_box),
    }];
  });
}

function parseProductDetails(data) {
  const buybox = data?.buybox || {};
  const sellerDetail = data?.seller_detail || {};
  const selected = (buybox.items || []).find((item) => item?.is_selected) || (buybox.items || [])[0] || {};
  const buyboxSellerDetail = buybox.seller_detail || buybox.seller || selected.seller_detail || selected.seller || {};
  const seller = firstText(
    buybox.seller_name,
    buybox.display_name,
    buyboxSellerDetail.display_name,
    buyboxSellerDetail.name,
    buyboxSellerDetail.seller_name,
    buyboxSellerDetail.trading_name,
    selected.seller_name,
    selected.display_name,
    sellerDetail.display_name,
    sellerDetail.name,
    sellerDetail.seller_name,
    sellerDetail.trading_name,
  );
  let buyBoxPrice = positiveNumber(
    buybox.pretty_price
    ?? buybox.price
    ?? buybox.selling_price
    ?? buybox?.prices?.selling_price,
  );

  if (!buyBoxPrice) {
    buyBoxPrice = positiveNumber(selected?.pretty_price ?? selected?.price ?? selected?.selling_price);
  }

  const rawOffers = data?.other_offers || data?.offers || data?.marketplace_offers || buybox?.other_offers || [];
  const offers = parseRawOffers(rawOffers);
  if (buyBoxPrice) {
    offers.unshift({
      seller,
      price: buyBoxPrice,
      inStock: true,
      isBuyBox: true,
    });
  }

  return {
    buyBoxPrice,
    buyBoxSeller: seller,
    offers: offers.filter((offer) => offer.inStock),
  };
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPublicSellerName(value) {
  return String(value || '')
    .replace(/\s+(VAT Registered|Seller Score|Other Offers|eBucks|Discovery|Add to Cart|FREE SAME DAY|FREE DELIVERY|Estimated Delivery|Get it|T&Cs Apply).*$/i, '')
    .replace(/[·•|]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function soldBySellerFromText(text) {
  const candidates = [
    /Sold\s+by\s+(.{1,120}?)(?=\s+(?:VAT Registered|Seller Score|Other Offers|eBucks|Discovery|Add to Cart|FREE SAME DAY|FREE DELIVERY|Estimated Delivery|Get it|T&Cs Apply)\b|$)/i,
    /Sold\s+by\s+([A-Za-z0-9][A-Za-z0-9&'().,\-\s]{1,90})/i,
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    const seller = cleanPublicSellerName(match?.[1] || '');
    if (seller) return seller;
  }

  return '';
}

function parsePublicPageDetails(html, storeName = '') {
  const text = textFromHtml(html);
  if (!text || /cloudflare|attention required|enable cookies/i.test(text)) {
    return { buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  }

  const buyBoxSeller = soldBySellerFromText(text);
  const priceMatch = text.match(/\bR\s*([0-9][0-9\s,]*(?:\.[0-9]{2})?)\b/);
  const buyBoxPrice = priceMatch ? positiveNumber(priceMatch[1]) : null;
  const offers = [];

  if (buyBoxPrice && buyBoxSeller) {
    offers.push({ seller: buyBoxSeller, price: buyBoxPrice, inStock: true, isBuyBox: true });
  }

  if (storeName) {
    const ownOfferPrice = priceBeforeStoreInOtherOffers(text, storeName);
    if (ownOfferPrice) {
      offers.push({ seller: storeName, price: ownOfferPrice, inStock: true, isBuyBox: false });
    }
  }

  return { buyBoxPrice, buyBoxSeller, offers };
}

async function fetchPublicPageDetails(row, storeName = '') {
  const url = offerUrlFor(row);
  if (!url) return { source: 'no_public_url', buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-ZA,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    if (!upstream.ok) {
      return { source: `public_page_http_${upstream.status}`, buyBoxPrice: null, buyBoxSeller: '', offers: [] };
    }
    const html = await upstream.text();
    return { source: 'public_page_html', ...parsePublicPageDetails(html, storeName) };
  } catch {
    return { source: 'public_page_error', buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  }
}

function findSignals(value, path = '', output = []) {
  if (output.length >= 80 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => findSignals(item, `${path}[${index}]`, output));
    return output;
  }
  if (typeof value !== 'object') return output;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (/seller|buy.?box|winner|offer|merchant/i.test(key)) {
      output.push({
        path: nextPath,
        value: typeof child === 'object' ? JSON.stringify(child).slice(0, 300) : String(child).slice(0, 300),
      });
    }
    findSignals(child, nextPath, output);
  }
  return output;
}

function parseSellerOfferDetails(data) {
  const candidates = [
    data?.buybox,
    data?.buy_box,
    data?.buy_box_winner,
    data?.buybox_winner,
    data?.winning_offer,
    data?.winner,
    data?.offer,
    data,
  ].filter(Boolean);

  let buyBoxSeller = '';
  let buyBoxPrice = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const sellerDetail = candidate.seller || candidate.seller_detail || candidate.seller_info || candidate.merchant || candidate.merchant_detail || {};
    buyBoxSeller = buyBoxSeller || firstText(
      candidate.seller_name,
      candidate.seller_display_name,
      candidate.display_name,
      candidate.merchant_name,
      sellerDetail.display_name,
      sellerDetail.name,
      sellerDetail.seller_name,
      sellerDetail.trading_name,
    );
    buyBoxPrice = buyBoxPrice || positiveNumber(
      candidate.price
      ?? candidate.selling_price
      ?? candidate.offer_price
      ?? candidate.buy_box_price
      ?? candidate?.prices?.selling_price
      ?? candidate?.pricing?.selling_price,
    );
  }

  return { buyBoxSeller, buyBoxPrice, signals: findSignals(data) };
}

async function fetchSellerOfferDetails(storeName, row) {
  const sku = skuFor(row);
  const identifiers = [
    row?.offer_id,
    sku,
    row?.barcode,
  ].map((item) => String(item ?? '').trim()).filter(Boolean);
  if (identifiers.length === 0) return { source: 'seller_offer_no_identifier', buyBoxPrice: null, buyBoxSeller: '', offers: [], signals: [] };
  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const failedSources = [];
  let failedSignals = [];
  for (const identifier of identifiers) {
    const url = new URL(`/v2/offers/offer/${encodeURIComponent(identifier)}`, baseUrl);
    try {
      const upstream = await fetch(url, { headers: takealotHeaders(storeName) });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        failedSources.push(`${identifier}:http_${upstream.status}`);
        failedSignals = failedSignals.concat(findSignals(data));
        continue;
      }
      const parsed = parseSellerOfferDetails(data);
      return {
        source: `seller_offer_api:${identifier}`,
        buyBoxPrice: parsed.buyBoxPrice,
        buyBoxSeller: parsed.buyBoxSeller,
        offers: parsed.buyBoxPrice && parsed.buyBoxSeller ? [{ seller: parsed.buyBoxSeller, price: parsed.buyBoxPrice, inStock: true, isBuyBox: true }] : [],
        signals: parsed.signals,
      };
    } catch {
      failedSources.push(`${identifier}:error`);
    }
  }
  return { source: `seller_offer_failed(${failedSources.join(',')})`, buyBoxPrice: null, buyBoxSeller: '', offers: [], signals: failedSignals };
}

async function fetchProductDetails(row, storeName) {
  const plid = extractPlid(offerUrlFor(row));
  if (!plid) return fetchSellerOfferDetails(storeName, row);
  const shouldVerifyPublicVariantPage = hasVariantSuffix(titleFor(row));
  const url = `https://api.takealot.com/rest/v-1-10-0/product-details/PLID${plid}`;
  let productDetails = { source: 'no_product_details', buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-ZA,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    if (upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      productDetails = { source: 'product_details_api', ...parseProductDetails(data) };
    } else {
      productDetails = { source: `product_details_http_${upstream.status}`, buyBoxPrice: null, buyBoxSeller: '', offers: [] };
    }
  } catch {
    productDetails = { source: 'product_details_error', buyBoxPrice: null, buyBoxSeller: '', offers: [] };
  }

  if (sellerIsKnown(productDetails.buyBoxSeller) && !shouldVerifyPublicVariantPage) return productDetails;

  const sellerOfferDetails = await fetchSellerOfferDetails(storeName, row);
  if (sellerIsKnown(sellerOfferDetails.buyBoxSeller) && !shouldVerifyPublicVariantPage) {
    return {
      source: `${productDetails.source}+${sellerOfferDetails.source}`,
      buyBoxPrice: sellerOfferDetails.buyBoxPrice ?? productDetails.buyBoxPrice,
      buyBoxSeller: sellerOfferDetails.buyBoxSeller,
      offers: [
        ...(sellerOfferDetails.offers || []),
        ...(productDetails.offers || []),
      ],
      signals: sellerOfferDetails.signals,
    };
  }

  const pageDetails = await fetchPublicPageDetails(row, storeName);
  if (sellerIsKnown(pageDetails.buyBoxSeller)) {
    return {
      source: `${productDetails.source}+${sellerOfferDetails.source}+${pageDetails.source}`,
      buyBoxPrice: pageDetails.buyBoxPrice ?? productDetails.buyBoxPrice,
      buyBoxSeller: pageDetails.buyBoxSeller,
      offers: [
        ...(pageDetails.offers || []),
        ...(sellerOfferDetails.offers || []),
        ...(productDetails.offers || []),
      ],
      signals: sellerOfferDetails.signals,
    };
  }
  return {
    source: `${productDetails.source}+${sellerOfferDetails.source}+${pageDetails.source}`,
    buyBoxPrice: pageDetails.buyBoxPrice ?? productDetails.buyBoxPrice,
    buyBoxSeller: pageDetails.buyBoxSeller || productDetails.buyBoxSeller,
    offers: [
      ...(pageDetails.offers || []),
      ...(sellerOfferDetails.offers || []),
      ...(productDetails.offers || []),
    ],
    signals: sellerOfferDetails.signals,
  };
}

function findOwnVariantAtBuyBoxPrice({ row, ownRows, buyBoxPrice }) {
  if (buyBoxPrice === null) return null;
  const sku = skuFor(row);
  const title = titleFor(row);
  const normalizedTitle = normalizeVariantTitle(title);
  if (!sku || normalizedTitle.length < 24) return null;

  return (ownRows || []).find((candidate) => {
    const candidateSku = skuFor(candidate);
    if (!candidateSku || candidateSku === sku) return false;
    if (stockFor(candidate) <= 0 || isDisabledRow(candidate)) return false;
    if (!samePrice(myPriceFor(candidate), buyBoxPrice)) return false;

    const candidateTitle = titleFor(candidate);
    const normalizedCandidateTitle = normalizeVariantTitle(candidateTitle);
    if (!normalizedCandidateTitle) return false;
    return normalizedCandidateTitle === normalizedTitle || sharedPrefixLength(title, candidateTitle) >= 35;
  }) || null;
}

function evaluateAlert({ row, storeName, productDetails, ownRows = [] }) {
  const sku = skuFor(row);
  const myPrice = myPriceFor(row);
  const stock = stockFor(row);
  const title = titleFor(row);

  if (!sku || !myPrice) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'none',
      alertMessage: '',
      isActive: false,
      isOutOfStock: stock <= 0,
      source: productDetails.source,
    };
  }

  if (stock <= 0) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'out_of_stock',
      alertMessage: '',
      isActive: false,
      isOutOfStock: true,
      source: productDetails.source,
    };
  }

  const buyBoxSeller = productDetails.buyBoxSeller || '';
  if (
    productDetails.buyBoxPrice !== null
    && sellerIsKnown(buyBoxSeller)
    && sameSeller(buyBoxSeller, storeName)
  ) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: buyBoxSeller,
      priceGap: null,
      alertLevel: 'none',
      alertType: 'own_buy_box',
      alertMessage: '',
      isActive: false,
      isOutOfStock: false,
      source: productDetails.source,
    };
  }

  if (
    productDetails.buyBoxPrice !== null
    && sellerIsKnown(buyBoxSeller)
    && !sameSeller(buyBoxSeller, storeName)
  ) {
    const priceGap = Number((myPrice - productDetails.buyBoxPrice).toFixed(2));
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: productDetails.buyBoxPrice,
      lowestCompetitorSeller: buyBoxSeller,
      priceGap,
      alertLevel: 'high',
      alertType: 'lost_buy_box',
      alertMessage: `${sku} Buy Box is occupied by ${buyBoxSeller}. My price R ${myPrice.toFixed(2)}, Buy Box R ${productDetails.buyBoxPrice.toFixed(2)}.`,
      isActive: true,
      isOutOfStock: false,
      source: productDetails.source,
    };
  }

  if (
    productDetails.buyBoxPrice !== null
    && productDetails.buyBoxPrice < myPrice
    && productDetails.source.includes('product_details_api')
    && (!sellerIsKnown(buyBoxSeller) || !sameSeller(buyBoxSeller, storeName))
  ) {
    const ownVariant = findOwnVariantAtBuyBoxPrice({ row, ownRows, buyBoxPrice: productDetails.buyBoxPrice });
    if (ownVariant) {
      return {
        sku,
        title,
        myPrice,
        buyBoxPrice: productDetails.buyBoxPrice,
        lowestCompetitorPrice: productDetails.buyBoxPrice,
        lowestCompetitorSeller: storeName,
        priceGap: null,
        alertLevel: 'none',
        alertType: 'own_variant',
        alertMessage: `Buy Box price matches own variant ${skuFor(ownVariant)}.`,
        isActive: false,
        isOutOfStock: false,
        source: `${productDetails.source}+own_variant:${skuFor(ownVariant)}`,
      };
    }

    if (!sellerIsKnown(buyBoxSeller) && hasVariantSuffix(title)) {
      return {
        sku,
        title,
        myPrice,
        buyBoxPrice: productDetails.buyBoxPrice,
        lowestCompetitorPrice: null,
        lowestCompetitorSeller: '',
        priceGap: null,
        alertLevel: 'none',
        alertType: 'variant_uncertain',
        alertMessage: 'Variant product has unknown Buy Box seller; skip confirmed alert to avoid color/size mismatch.',
        isActive: false,
        isOutOfStock: false,
        source: `${productDetails.source}+variant_uncertain`,
      };
    }

    const priceGap = Number((myPrice - productDetails.buyBoxPrice).toFixed(2));
    const sellerName = buyBoxSeller || 'Buy Box seller';
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: productDetails.buyBoxPrice,
      lowestCompetitorSeller: sellerName,
      priceGap,
      alertLevel: 'high',
      alertType: 'lost_buy_box',
      alertMessage: `${sku} exact product Buy Box is R ${priceGap.toFixed(2)} lower than my price. Please open Takealot to confirm seller.`,
      isActive: true,
      isOutOfStock: false,
      source: productDetails.source,
    };
  }

  const competitorOffers = productDetails.offers
    .filter((offer) => sellerIsKnown(offer.seller))
    .filter((offer) => !sameSeller(offer.seller, storeName))
    .filter((offer) => offer.price < myPrice)
    .sort((a, b) => a.price - b.price);

  const bestCompetitor = competitorOffers[0];
  if (!bestCompetitor) {
    return {
      sku,
      title,
      myPrice,
      buyBoxPrice: productDetails.buyBoxPrice,
      lowestCompetitorPrice: null,
      lowestCompetitorSeller: '',
      priceGap: null,
      alertLevel: 'none',
      alertType: 'none',
      alertMessage: '',
      isActive: false,
      isOutOfStock: false,
      source: productDetails.source,
    };
  }

  const priceGap = Number((myPrice - bestCompetitor.price).toFixed(2));
  const lostBuyBox = bestCompetitor.isBuyBox || (
    productDetails.buyBoxPrice !== null
    && productDetails.buyBoxPrice === bestCompetitor.price
  );

  return {
    sku,
    title,
    myPrice,
    buyBoxPrice: productDetails.buyBoxPrice,
    lowestCompetitorPrice: bestCompetitor.price,
    lowestCompetitorSeller: bestCompetitor.seller,
    priceGap,
    alertLevel: 'high',
    alertType: lostBuyBox ? 'lost_buy_box' : 'followed_price',
    alertMessage: `${sku} confirmed competitor ${bestCompetitor.seller} is R ${priceGap.toFixed(2)} lower than my price.`,
    isActive: true,
    isOutOfStock: false,
    source: productDetails.source,
  };
}

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function supabaseUrl(path) {
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL');
  return `${base.replace(/\/$/, '')}/rest/v1/${path}`;
}

async function supabaseRequest(method, path, body, headers = {}) {
  const response = await fetch(supabaseUrl(path), {
    method,
    headers: supabaseHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Supabase ${method} ${path} failed: ${response.status}`);
  }
  return response;
}

function incrementCount(map, key) {
  const normalizedKey = String(key || 'unknown').trim() || 'unknown';
  map[normalizedKey] = (map[normalizedKey] || 0) + 1;
}

async function clearStoreRepricingAlerts(storeName) {
  const normalizedStoreName = encodeURIComponent(storeName);
  await supabaseRequest('DELETE', `repricing_alerts?shop_name=eq.${normalizedStoreName}`, undefined, {
    Prefer: 'return=minimal',
  });
}

async function syncRepricingResult({ storeName, storeId, row, alert, checkedAt }) {
  const sku = alert.sku || skuFor(row);
  if (!sku) return;
  const alertId = `${storeName.trim().toLowerCase()}:${sku.trim().toUpperCase()}`;
  const title = alert.title || titleFor(row);
  const productPayload = {
    id: alertId,
    shop_name: storeName,
    store_id: storeId,
    sku,
    tsin: tsinFor(row),
    title,
    offer_url: offerUrlFor(row),
    canonical_url: offerUrlFor(row),
    updated_at: checkedAt,
  };
  await supabaseRequest('POST', 'repricing_products?on_conflict=id', productPayload, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });

  if (!alert.isActive) return;

  const alertPayload = {
    id: alertId,
    shop_name: storeName,
    store_id: storeId,
    sku,
    title,
    my_price: alert.myPrice,
    buy_box_price: alert.buyBoxPrice,
    lowest_competitor_price: alert.lowestCompetitorPrice,
    lowest_competitor_seller: alert.lowestCompetitorSeller,
    price_gap: alert.priceGap,
    alert_level: alert.alertLevel,
    alert_type: alert.alertType,
    alert_message: alert.alertMessage,
    is_active: alert.isActive,
    checked_at: checkedAt,
    updated_at: checkedAt,
  };
  await supabaseRequest('POST', 'repricing_alerts?on_conflict=id', alertPayload, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

async function fetchTakealotRows(storeName, limit, requestedSku = '') {
  const apiKey = apiKeyForStore(storeName);
  if (!apiKey) throw new Error(`Store ${storeName} has no Takealot API Key configured`);

  const baseUrl = process.env.TAKEALOT_API_BASE_URL || 'https://seller-api.takealot.com';
  const inventoryPath = process.env.TAKEALOT_INVENTORY_PATH || '/v2/offers';
  const pageSize = numberFromEnv('TAKEALOT_PAGE_SIZE', 100);
  const maxPages = numberFromEnv('TAKEALOT_REPRICING_MAX_PAGES', numberFromEnv('TAKEALOT_MAX_PAGES', 50));
  const headers = { Accept: 'application/json', Authorization: `Key ${apiKey}` };
  const allRows = [];
  const contextRows = [];
  const seenKeys = new Set();
  const requestedSkuKey = String(requestedSku || '').trim().toUpperCase();
  let pagesFetched = 0;
  let totalResults = null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(inventoryPath, baseUrl);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('page_number', String(pageNumber));
    const upstream = await fetch(url, { headers });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(payload.message || payload.error || `Takealot API request failed: ${upstream.status}`);

    const rows = rowsFromPayload(payload);
    const payloadTotal = Number(payload?.total_results);
    if (Number.isFinite(payloadTotal)) totalResults = payloadTotal;
    pagesFetched = pageNumber;

    let newRowsOnPage = 0;
    for (const row of rows) {
      const key = rowKey(row);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      newRowsOnPage += 1;
      if (isDisabledRow(row)) continue;
      contextRows.push(row);
      if (requestedSkuKey && skuFor(row) !== requestedSkuKey) continue;
      allRows.push(row);
      if (!requestedSkuKey && limit && allRows.length >= limit) return { rows: allRows, contextRows, pagesFetched, totalResults };
    }

    if (rows.length < pageSize) break;
    if (newRowsOnPage === 0) break;
    if (totalResults !== null && seenKeys.size >= totalResults) break;
  }

  return { rows: allRows, contextRows, pagesFetched, totalResults };
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const storeName = String(request.query.store || DEFAULT_STORE).trim();
  const requestedSku = String(request.query.sku || '').trim();
  const requestedLimit = Number(request.query.limit);
  const limit = requestedSku
    ? null
    : (Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : null);
  const storeId = storeName.toLowerCase();
  const checkedAt = new Date().toISOString();

  try {
    const { rows, contextRows, pagesFetched, totalResults } = await fetchTakealotRows(storeName, limit, requestedSku);
    if (!requestedSku) await clearStoreRepricingAlerts(storeName);
    const details = [];
    const alertDetails = [];
    let checked = 0;
    let confirmedAlerts = 0;
    let inactive = 0;
    let errors = 0;
    const inactiveByType = {};
    const sourceCounts = {};

    for (const row of rows) {
      try {
        const productDetails = await fetchProductDetails(row, storeName);
        const alert = evaluateAlert({ row, storeName, productDetails, ownRows: contextRows });
        await syncRepricingResult({ storeName, storeId, row, alert, checkedAt });
        checked += 1;
        if (alert.isActive) confirmedAlerts += 1;
        else {
          inactive += 1;
          incrementCount(inactiveByType, alert.alertType);
        }
        incrementCount(sourceCounts, alert.source || productDetails.source);
        const detail = {
          sku: alert.sku,
          title: alert.title,
          myPrice: alert.myPrice,
          buyBoxPrice: alert.buyBoxPrice,
          buyBoxSeller: productDetails.buyBoxSeller,
          competitorPrice: alert.lowestCompetitorPrice,
          competitorSeller: alert.lowestCompetitorSeller,
          alertLevel: alert.alertLevel,
          alertType: alert.alertType,
          isActive: alert.isActive,
          source: alert.source,
          message: alert.alertMessage,
          signals: request.query.debug ? productDetails.signals : undefined,
        };
        details.push(detail);
        if (alert.isActive) alertDetails.push(detail);
      } catch (error) {
        console.error(error);
        errors += 1;
        details.push({ sku: skuFor(row), error: error instanceof Error ? error.message : 'Unknown row error' });
      }
    }

    response.status(200).json({
      ok: errors === 0,
      store: storeName,
      checked,
      confirmedAlerts,
      inactive,
      errors,
      pagesFetched,
      totalResults,
      inactiveByType,
      sourceCounts,
      details: details.slice(0, 50),
      alertDetails,
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Repricing monitor failed' });
  }
}
