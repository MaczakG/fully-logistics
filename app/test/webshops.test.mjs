// Webshop integrations.
//   1. Adapters in plain Node with a scripted fetch: mapping of the platforms' documentation
//      examples to createOrder() input, pagination, and the exact requests (auth headers, query
//      parameters, bodies) for listing, fulfilment and stock.
//   2. The sync engine inside the Worker (test/test-worker.js, webshops.runWithMockedHttp): import,
//      cursor, unknown SKU and retry, de-duplication, cancellation, fulfilment push and retry,
//      paused connections, locks, budget, stock sync.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { createHttp, readSettings, resolveShipping, fromBudapestLocal, toBudapestLocal, orderLines, WebshopError } from '../worker/integrations/webshops/common.js';
import { parseXml, buildXml } from '../worker/integrations/webshops/xml.js';
import { scriptedFetch } from '../worker/integrations/webshops/testing.js';
import * as shopify from '../worker/integrations/webshops/shopify.js';
import * as woocommerce from '../worker/integrations/webshops/woocommerce.js';
import * as shoprenter from '../worker/integrations/webshops/shoprenter.js';
import * as unas from '../worker/integrations/webshops/unas.js';

const noSleep = async () => {};
const SINCE = new Date('2026-10-15T00:00:00Z');
const json = (r) => JSON.parse(r.body);

// An adapter client with a scripted transport and an in-memory token store.
function adapter(platform, { shopUrl = '', credentials = {}, settings = {}, routes = [], token = null } = {}) {
  const { fetch, requests } = scriptedFetch(routes);
  const logs = [];
  const http = createHttp({ fetch, sleep: noSleep, log: async (e) => { logs.push(e); } });
  const store = { value: token };
  const tokens = { get: async () => store.value, set: async (t, expiresAt) => { store.value = t ? { token: t, expiresAt } : null; } };
  const client = platform.connect({ shopUrl, credentials, settings: readSettings(platform.settingFields, settings), http, tokens, sleep: noSleep });
  return { client, requests, logs, store };
}

// ---------------------------------------------------------------- fixtures

const SHOP = 'kutya.myshopify.com';
const GRAPHQL = `https://${SHOP}/admin/api/2026-10/graphql.json`;
const gql = (data) => ({ data, extensions: { cost: { requestedQueryCost: 12, actualQueryCost: 8, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1992, restoreRate: 100 } } } });
const lineNode = (id, sku, qty, extra = {}) => ({ id: `gid://shopify/LineItem/${id}`, sku, name: `Termék ${sku}`, quantity: qty, currentQuantity: qty, requiresShipping: true, ...extra });

function shopifyOrder(n, extra = {}) {
  return {
    id: `gid://shopify/Order/55500${n}`,
    legacyResourceId: `55500${n}`,
    name: `#100${n}`,
    createdAt: `2026-10-15T08:0${n}:00Z`,
    updatedAt: `2026-10-15T09:0${n}:00Z`,
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: `vevo${n}@example.com`,
    phone: null,
    note: 'Kérem, csengessen.',
    paymentGatewayNames: ['shopify_payments'],
    presentmentCurrencyCode: 'HUF',
    customAttributes: [],
    totalOutstandingSet: { presentmentMoney: { amount: '0.0', currencyCode: 'HUF' } },
    shippingAddress: { name: 'Kiss Anna', firstName: 'Anna', lastName: 'Kiss', company: null, address1: 'Fő utca 1.', address2: '2. emelet', city: 'Budapest', zip: '1111', countryCodeV2: 'HU', phone: '+36301112222' },
    billingAddress: { name: 'Kiss Anna', phone: null },
    shippingLine: { title: 'GLS házhozszállítás', code: 'gls-home' },
    lineItems: { pageInfo: { hasNextPage: false, endCursor: 'l1' }, nodes: [lineNode(`${n}1`, 'KB-1001', 2)] },
    ...extra,
  };
}
const ordersPage = (nodes, next = null) => gql({ orders: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } });

// The WooCommerce REST API documentation's "List all orders" example order (727), unchanged.
const WOO_727 = {
  id: 727, parent_id: 0, number: '727', order_key: 'wc_order_58d2d042d1d', created_via: 'rest-api', version: '3.0.0', status: 'processing', currency: 'USD',
  date_created: '2017-03-22T16:28:02', date_created_gmt: '2017-03-22T19:28:02', date_modified: '2017-03-22T16:28:08', date_modified_gmt: '2017-03-22T19:28:08',
  discount_total: '0.00', discount_tax: '0.00', shipping_total: '10.00', shipping_tax: '0.00', cart_tax: '1.35', total: '29.35', total_tax: '1.35', prices_include_tax: false,
  customer_id: 0, customer_ip_address: '', customer_user_agent: '', customer_note: '',
  billing: { first_name: 'John', last_name: 'Doe', company: '', address_1: '969 Market', address_2: '', city: 'San Francisco', state: 'CA', postcode: '94103', country: 'US', email: 'john.doe@example.com', phone: '(555) 555-5555' },
  shipping: { first_name: 'John', last_name: 'Doe', company: '', address_1: '969 Market', address_2: '', city: 'San Francisco', state: 'CA', postcode: '94103', country: 'US' },
  payment_method: 'bacs', payment_method_title: 'Direct Bank Transfer', transaction_id: '', date_paid: '2017-03-22T16:28:08', date_paid_gmt: '2017-03-22T19:28:08', date_completed: null, date_completed_gmt: null, cart_hash: '',
  meta_data: [{ id: 13106, key: '_download_permissions_granted', value: 'yes' }, { id: 13109, key: '_order_stock_reduced', value: 'yes' }],
  line_items: [
    { id: 315, name: 'Woo Single #1', product_id: 93, variation_id: 0, quantity: 2, tax_class: '', subtotal: '6.00', subtotal_tax: '0.45', total: '6.00', total_tax: '0.45', taxes: [{ id: 75, total: '0.45', subtotal: '0.45' }], meta_data: [], sku: '', price: 3 },
    { id: 316, name: 'Ship Your Idea &ndash; Color: Black, Size: M Test', product_id: 22, variation_id: 23, quantity: 1, tax_class: '', subtotal: '12.00', subtotal_tax: '0.90', total: '12.00', total_tax: '0.90', taxes: [{ id: 75, total: '0.9', subtotal: '0.9' }], meta_data: [{ id: 2095, key: 'pa_color', value: 'black' }, { id: 2096, key: 'size', value: 'M Test' }], sku: 'Bar3', price: 12 },
  ],
  tax_lines: [{ id: 318, rate_code: 'US-CA-STATE TAX', rate_id: 75, label: 'State Tax', compound: false, tax_total: '1.35', shipping_tax_total: '0.00', meta_data: [] }],
  shipping_lines: [{ id: 317, method_title: 'Flat Rate', method_id: 'flat_rate', total: '10.00', total_tax: '0.00', taxes: [], meta_data: [] }],
  fee_lines: [], coupon_lines: [], refunds: [],
};

// A Hungarian order in the same shape: COD, pickup point plugin meta, our SKUs.
const WOO_HU = {
  ...WOO_727, id: 812, number: '812', status: 'processing', currency: 'HUF', total: '15990',
  date_created_gmt: '2026-10-15T07:00:00', date_modified_gmt: '2026-10-15T07:30:00', customer_note: 'Délután legyen kint.',
  billing: { first_name: 'Anna', last_name: 'Kiss', company: '', address_1: 'Fő utca 1.', address_2: '', city: 'Budapest', state: '', postcode: '1111', country: 'HU', email: 'anna@example.com', phone: '+36301112222' },
  shipping: { first_name: 'Anna', last_name: 'Kiss', company: 'Kiss Bt.', address_1: 'Fő utca 1.', address_2: '3. ajtó', city: 'Budapest', state: '', postcode: '1111', country: 'HU', phone: '' },
  payment_method: 'cod', payment_method_title: 'Utánvét',
  meta_data: [{ id: 1, key: '_vp_woo_pont_point_id', value: 'HU-CS-1185' }, { id: 2, key: '_vp_woo_pont_provider', value: 'postapont_automata' }],
  line_items: [{ id: 901, name: 'Kutyatáp', quantity: 2, sku: 'KB-1001' }, { id: 902, name: 'Ajándékcsomagolás', quantity: 1, sku: 'GIFT' }],
  shipping_lines: [{ id: 903, method_title: 'Csomagautomata', method_id: 'vp_pont' }],
};

// The Shoprenter orderExtend documentation fixture (fixtures/api/order_extend/response/json/get_id.json),
// without orderTotals, coupon and addons, which the import does not read.
const SR_ORDER = {
  href: 'https://shopname.api.myshoprenter.hu/orderExtend/b3JkZXItb3JkZXJfaWQ9MTcy', id: 'b3JkZXItb3JkZXJfaWQ9MTcy', innerId: '172', invoiceId: '0', invoicePrefix: '',
  firstname: 'Test', lastname: 'Test', phone: '+36201234567', fax: '', email: 'test@test.com',
  shippingFirstname: 'Test', shippingLastname: 'Test', shippingCompany: '', shippingAddress1: 'Test street 11', shippingAddress2: '', shippingCity: 'Test', shippingPostcode: '4033',
  shippingZoneName: '', shippingCountryName: 'Hungary', shippingAddressFormat: '', shippingMethodName: 'Home delivery with courier service', shippingMethodTaxRate: '25.0000',
  shippingMethodTaxName: '25 %', shippingMethodExtension: 'wseship', shippingReceivingPointId: '0',
  paymentFirstname: 'Test', paymentLastname: 'Test', paymentCompany: '', paymentAddress1: 'Test street 11', paymentAddress2: '', paymentCity: 'Test', paymentPostcode: '4033',
  paymentZoneName: '', paymentCountryName: 'Hungary', paymentAddressFormat: '', paymentMethodName: 'Payment method', paymentMethodCode: 'cod', paymentMethodTaxRate: '0.0000',
  paymentMethodTaxName: '', paymentMethodAfter: '1', taxNumber: '', comment: 'Comment', total: '3990.0000', value: '1.00000000', couponTaxRate: '-1.0000',
  dateCreated: '2019-09-06T15:47:59', dateUpdated: '2019-09-06T15:47:59', ip: '11.11.11.11', pickPackPontShopCode: '100010', loyaltyPointsTaxRate: '-1.0000',
  shippingCountry: { href: 'https://shopname.api.myshoprenter.hu/countries/Y291bnRyeS1jb3VudHJ5X2lkPTk3', id: 'Y291bnRyeS1jb3VudHJ5X2lkPTk3', name: 'Hungary', isoCode2: 'HU', isoCode3: 'HUN', status: '1' },
  orderStatus: { href: 'https://shopname.api.myshoprenter.hu/orderStatuses/b3JkZXJTdGF0dXMtb3JkZXJfc3RhdHVzX2lkPTE=' },
  currency: { href: 'https://shopname.api.myshoprenter.hu/currencies/Y3VycmVuY3ktY3VycmVuY3lfaWQ9NA==', id: 'Y3VycmVuY3ktY3VycmVuY3lfaWQ9NA==', name: 'HUF', code: 'HUF', value: '1.00000000' },
  orderProducts: [
    { id: 'b3JkZXJQcm9kdWN0LW9yZGVyX3Byb2R1Y3RfaWQ9MTU3', name: 'Mini Tündér karkötő', sku: '997000004', price: '400.0000', total: '400.0000', stock1: '1', stock2: '0', stock3: '0', stock4: '0' },
    { id: 'b3JkZXJQcm9kdWN0LW9yZGVyX3Byb2R1Y3RfaWQ9MTg1', name: 'Shaver Ken', sku: '99400000', price: '6000.0000', total: '6000.0000', stock1: '1', stock2: '0', stock3: '0', stock4: '0' },
  ],
  externalInfo: { partner_order_id: '12345', partner_prefix: 'EMAG' },
};
const srPage = (items, page = 0, pageCount = 1) => ({
  href: `https://shopname.api.myshoprenter.hu/orderExtend?full=1&page=${page}&limit=50`, page, pageCount, limit: 50,
  next: page + 1 < pageCount ? { href: `https://shopname.api.myshoprenter.hu/orderExtend?full=1&page=${page + 1}&limit=50` } : null, items,
});
const SR_STATUS_1 = 'b3JkZXJTdGF0dXMtb3JkZXJfc3RhdHVzX2lkPTE=';
const SR_STATUS_4 = Buffer.from('orderStatus-order_status_id=4').toString('base64');

// The UNAS getOrder documentation example ("Rendelések lekérése" > Válasz), unchanged.
const UNAS_ORDERS = `<?xml version="1.0" encoding="UTF-8" ?>
<Orders>
	<Order>
	    <Action>modify</Action>
		<Key>1000-1000000</Key>
		<Date>2012.01.01 10:00:00</Date>
		<DateMod>2012.02.01 10:00:00</DateMod>
		<Lang>hu</Lang>
		<Customer>
			<Id>100000</Id>
			<Email>unas@unas.hu</Email>
			<Username></Username>
			<Contact>
				<Name><![CDATA[Kis János]]></Name>
				<Phone><![CDATA[+3699111111]]></Phone>
				<Mobile><![CDATA[+36301111111]]></Mobile>
			</Contact>
			<Addresses>
				<Invoice>
					<Name><![CDATA[Teszt János]]></Name>
					<ZIP>1111</ZIP>
					<City><![CDATA[Teszt Város]]></City>
					<Street><![CDATA[Tej út 2.]]></Street>
					<StreetName><![CDATA[Tej]]></StreetName>
					<StreetType><![CDATA[út]]></StreetType>
					<StreetNumber><![CDATA[2]]></StreetNumber>
					<County><![CDATA[]]></County>
					<Country>Magyarország</Country>
					<CountryCode>hu</CountryCode>
					<TaxNumber><![CDATA[12345678-9-00]]></TaxNumber>
					<EUTaxNumber><![CDATA[HU0123456789]]></EUTaxNumber>
					<CustomerType><![CDATA[private]]></CustomerType>
				</Invoice>
				<Shipping>
					<Name><![CDATA[Teszt János]]></Name>
					<ZIP>2222</ZIP>
					<City><![CDATA[Teszt Város]]></City>
					<Street><![CDATA[Tej út 10.]]></Street>
					<StreetName><![CDATA[Tej]]></StreetName>
					<StreetType><![CDATA[út]]></StreetType>
					<StreetNumber><![CDATA[10]]></StreetNumber>
					<County><![CDATA[]]></County>
					<Country>Magyarország</Country>
					<CountryCode>hu</CountryCode>
					<DeliveryPointID>157547</DeliveryPointID>
					<DeliveryPointGroup>gls_api_dropoffpoints</DeliveryPointGroup>
					<DeliveryPointSubGroup>csomagautomata</DeliveryPointSubGroup>
					<RecipientName>Teszt János</RecipientName>
				</Shipping>
			</Addresses>
			<Group>
				<Id>1234</Id>
				<Name><![CDATA[Törzsvásárló]]></Name>
				<ForeignID><![CDATA[12345]]></ForeignID>
			</Group>
			<Comment><![CDATA[Megjegyzés]]></Comment>
		</Customer>
		<Currency>HUF</Currency>
		<ExchangeValue>0.00290922</ExchangeValue>
		<Type><![CDATA[Garanciális]]></Type>
		<Status><![CDATA[Beérkezett]]></Status>
		<StatusDetails><![CDATA[---]]></StatusDetails>
		<StatusDateMod>2012.02.01 10:00:00</StatusDateMod>
		<StatusEmail>no</StatusEmail>
		<StatusID>123456</StatusID>
		<Authenticated>yes</Authenticated>
		<Payment>
			<Id>100</Id>
			<Name><![CDATA[Utalás]]></Name>
			<Type>transfer</Type>
			<Status>paid</Status>
			<Paid>1000</Paid>
			<Pending>500</Pending>
		</Payment>
		<Shipping>
			<Id>200</Id>
			<Name><![CDATA[Futárszolgálat]]></Name>
			<PackageNumber><![CDATA[PUDO123456789]]></PackageNumber>
			<ForeignID><![CDATA[654321]]></ForeignID>
		</Shipping>
		<Comments>
			<Comment>
				<Type>customer</Type>
				<Text><![CDATA[A vásárló megjegyzése]]></Text>
			</Comment>
			<Comment>
				<Type>customer_shipping</Type>
				<Text><![CDATA[A vásárló megjegyzése a szállító számára]]></Text>
			</Comment>
			<Comment>
				<Type>admin</Type>
				<Text><![CDATA[Az adminisztrátor megjegyzése, a vásárló nem látja]]></Text>
			</Comment>
		</Comments>
		<SumPriceGross>7620</SumPriceGross>
		<Items>
			<Item>
				<Id>1000</Id>
				<Sku>Cikkszam1</Sku>
				<Name><![CDATA[Termék név 1]]></Name>
				<Unit>db</Unit>
				<Quantity>1</Quantity>
				<PriceNet>1000</PriceNet>
				<PriceGross>1270</PriceGross>
				<Vat>27%</Vat>
			</Item>
			<Item>
				<Id>2000</Id>
				<Sku>Cikkszam2</Sku>
				<Name><![CDATA[Termék név 2]]></Name>
				<Variants>
					<Variant>
						<Id>1</Id>
						<Name><![CDATA[Szín]]></Name>
						<Value><![CDATA[Piros]]></Value>
					</Variant>
				</Variants>
				<Unit>db</Unit>
				<Quantity>1</Quantity>
				<PriceNet>2000</PriceNet>
				<PriceGross>2540</PriceGross>
				<Vat>27%</Vat>
			</Item>
			<Item>
				<Id>discount-percent</Id>
				<Sku>discount-percent</Sku>
				<Name><![CDATA[Kedvezmény (10%)]]></Name>
				<Unit>db</Unit>
				<Quantity>1</Quantity>
				<PriceNet>-1000</PriceNet>
				<PriceGross>-1270</PriceGross>
				<Vat>27%</Vat>
			</Item>
			<Item>
				<Id>shipping-cost</Id>
				<Sku>shipping-cost</Sku>
				<Name><![CDATA[Szállítási költség]]></Name>
				<Unit>db</Unit>
				<Quantity>1</Quantity>
				<PriceNet>1000</PriceNet>
				<PriceGross>1270</PriceGross>
				<Vat>27%</Vat>
			</Item>
		</Items>
	</Order>
</Orders>`;
const unasLogin = (token = 'unas-token-1') => `<?xml version="1.0" encoding="UTF-8" ?>
<Login><Token>${token}</Token><Expire>2099.01.01 10:00:00</Expire><ExpireTime>4070944800</ExpireTime><ShopId>12345</ShopId><Subscription>premium</Subscription>
<Permissions><Permission>getOrder</Permission><Permission>setOrder</Permission><Permission>setStock</Permission></Permissions>
<WebshopInfo><WebshopName>Teszt Webáruház</WebshopName></WebshopInfo><Status>ok</Status></Login>`;
const XML = { 'content-type': 'application/xml' };

// ======================================================================== adapters (plain Node)

describe('adapters (plain Node, scripted HTTP)', () => {
  test('common: carrier and courier service mapping, Budapest time, order lines', () => {
    const s = readSettings(shopify.settingFields, { carrier_map: 'GLS 12 óráig=gls:T12; MPL postán maradó=mpl:PM; Foxpost automata=foxpost', default_carrier: 'dpd' });
    assert.deepEqual(resolveShipping(s, ['GLS 12 óráig']), { carrier_code: 'gls', carrier_service: 'T12' });
    assert.deepEqual(resolveShipping(s, ['GLS 24H házhozszállítás']), { carrier_code: 'gls', carrier_service: '' }, 'a method title never becomes a paid service');
    assert.deepEqual(resolveShipping(s, ['mpl postán maradó']), { carrier_code: 'mpl', carrier_service: 'PM' });
    assert.deepEqual(resolveShipping(s, ['Magyar Posta házhoz']), { carrier_code: 'mpl', carrier_service: 'HA' });
    assert.deepEqual(resolveShipping(s, ['Átvételi pont'], { hint: 'mpl', mplMode: 'PP', pickupPointId: 'X' }), { carrier_code: 'mpl', carrier_service: 'PP' });
    assert.deepEqual(resolveShipping(s, ['Személyes átvétel']), { carrier_code: 'dpd', carrier_service: '' }, 'default carrier');
    assert.equal(fromBudapestLocal('2026-07-01T12:00:00'), '2026-07-01T10:00:00.000Z', 'summer time');
    assert.equal(fromBudapestLocal('2026.12.01 12:00:00'), '2026-12-01T11:00:00.000Z', 'winter time');
    assert.equal(toBudapestLocal(new Date('2026-10-15T00:00:00Z')), '2026-10-15T02:00:00');
    const { lines, problems } = orderLines(readSettings(shopify.settingFields, { ignore_skus: 'GIFT' }), [
      { sku: 'A', qty: 2 }, { sku: 'GIFT', qty: 1 }, { sku: '', qty: 1, name: 'Névtelen póló' }, { sku: 'B', qty: 1.5 }, { sku: 'C', qty: 0 },
    ]);
    assert.deepEqual(lines, [{ sku: 'A', qty: 2, external_line_id: '' }]);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /Névtelen póló.*nincs cikkszáma/);
    assert.match(problems[1], /B mennyisége nem egész/);
  });

  test('xml: parser and builder', () => {
    const doc = parseXml('<?xml version="1.0"?>\n<!-- c --><A x="1"><B>1 &amp; 2</B><B><![CDATA[<b>&nbsp;</b>]]></B><C/><D><E>é&#233;&#xE9;</E></D></A>');
    assert.equal(doc.name, 'A');
    assert.equal(doc.attrs.x, '1');
    assert.deepEqual(doc.all('B').map((b) => b.text()), ['1 & 2', '<b>&nbsp;</b>']);
    assert.equal(doc.text('C'), '');
    assert.equal(doc.text('D/E'), 'ééé');
    assert.equal(doc.get('X/Y'), null);
    assert.throws(() => parseXml('<A><B></A>'));
    assert.equal(buildXml('Params', { Key: 'a<b&c', List: { Item: [{ Sku: 1 }, { Sku: 2 }] }, Skip: undefined }),
      '<?xml version="1.0" encoding="UTF-8" ?>\n<Params><Key>a&lt;b&amp;c</Key><List><Item><Sku>1</Sku></Item><Item><Sku>2</Sku></Item></List></Params>');
  });

  test('shopify: orders query, mapping, filters and pagination', async () => {
    const cod = shopifyOrder(2, {
      displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Cash on Delivery (COD)'],
      totalOutstandingSet: { presentmentMoney: { amount: '12990.0', currencyCode: 'HUF' } },
      customAttributes: [{ key: 'csomagpont', value: 'HU-CS-1185' }],
      shippingLine: { title: 'MPL csomagautomata', code: 'mpl-cs' },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(21, 'KB-1002', 3), lineNode(22, 'GIFTCARD', 1, { requiresShipping: false }), lineNode(23, 'KB-1003', 2, { currentQuantity: 0 })] },
    });
    const { client, requests, logs } = adapter(shopify.platform, {
      shopUrl: 'https://kutya.myshopify.com/admin', credentials: { access_token: 'shpat_secret' },
      settings: { pickup_point_attribute: 'csomagpont', carrier_map: 'GLS házhozszállítás=gls' },
      routes: [
        { url: GRAPHQL, bodyIncludes: '"after":null', body: ordersPage([
          shopifyOrder(1), cod,
          shopifyOrder(3, { displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Banki átutalás'] }),
          shopifyOrder(4, { cancelledAt: '2026-10-15T09:30:00Z' }),
          shopifyOrder(5, { test: true }),
          shopifyOrder(6, { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(61, null, 1)] } }),
        ], 'c1') },
        { url: GRAPHQL, bodyIncludes: '"after":"c1"', body: ordersPage([]) },
      ],
    });
    const page1 = await client.listOrders({ since: SINCE, page: null });
    assert.equal(page1.nextPage, 'c1');
    const req = requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, GRAPHQL);
    assert.equal(req.headers['x-shopify-access-token'], 'shpat_secret');
    assert.equal(req.headers['content-type'], 'application/json');
    const body = json(req);
    assert.match(body.query, /orders\(first: \$first, after: \$after, query: \$query, sortKey: UPDATED_AT\)/);
    assert.deepEqual(body.variables, { first: 10, after: null, query: "updated_at:>='2026-10-15T00:00:00Z'" });

    const [o1, o2, o3, o4, o5, o6] = page1.orders;
    assert.equal(o1.state, 'import');
    assert.equal(o1.remoteId, 'gid://shopify/Order/555001');
    assert.equal(o1.externalId, '555001');
    assert.equal(o1.number, '#1001');
    assert.equal(o1.updatedAt, '2026-10-15T09:01:00.000Z');
    assert.deepEqual(o1.input, {
      customer_name: 'Kiss Anna', company: '', email: 'vevo1@example.com', phone: '+36301112222', country: 'HU', zip: '1111', city: 'Budapest',
      address: 'Fő utca 1., 2. emelet', pickup_point_id: '', carrier_code: 'gls', carrier_service: '', cod_amount: 0, currency: 'HUF',
      note: 'Kérem, csengessen.', ordered_at: '2026-10-15T08:01:00.000Z',
    });
    assert.deepEqual(o1.lines, [{ sku: 'KB-1001', qty: 2, external_line_id: '11' }]);
    assert.equal(o2.state, 'import', 'COD orders come in while pending');
    assert.equal(o2.input.cod_amount, 12990);
    assert.equal(o2.input.pickup_point_id, 'HU-CS-1185');
    assert.equal(o2.input.carrier_code, 'mpl');
    assert.equal(o2.input.carrier_service, 'CS', 'MPL delivery mode from the method name');
    assert.deepEqual(o2.lines, [{ sku: 'KB-1002', qty: 3, external_line_id: '21' }], 'no gift card, no removed line');
    assert.deepEqual([o3.state, o3.reason], ['skip', 'Fizetési állapot: pending.']);
    assert.equal(o4.state, 'cancelled');
    assert.deepEqual([o5.state, o5.reason], ['skip', 'Teszt rendelés.']);
    assert.equal(o6.state, 'import');
    assert.match(o6.problems[0], /nincs cikkszáma/);

    const page2 = await client.listOrders({ since: SINCE, page: 'c1' });
    assert.deepEqual(page2, { orders: [], nextPage: null });
    assert.equal(json(requests[1]).variables.after, 'c1');
    assert.ok(logs.every((l) => !JSON.stringify(l).includes('shpat_secret')), 'the token is never logged');
  });

  test('shopify: more than 50 line items are read with a follow-up query', async () => {
    const big = shopifyOrder(1, { lineItems: { pageInfo: { hasNextPage: true, endCursor: 'li50' }, nodes: [lineNode(1, 'KB-1001', 1)] } });
    const { client, requests } = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 't' },
      routes: [
        { url: GRAPHQL, bodyIncludes: 'FlOrderLines', body: gql({ order: { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(2, 'KB-1002', 4)] } } }) },
        { url: GRAPHQL, bodyIncludes: 'FlOrders', body: ordersPage([big]) },
      ],
    });
    const { orders } = await client.listOrders({ since: SINCE });
    assert.deepEqual(orders[0].lines.map((l) => `${l.sku}x${l.qty}`), ['KB-1001x1', 'KB-1002x4']);
    assert.deepEqual(json(requests[1]).variables, { id: 'gid://shopify/Order/555001', after: 'li50' });
  });

  test('shopify: client credentials grant, token cache, refresh on 401, throttling', async () => {
    const { client, requests, store } = adapter(shopify.platform, {
      shopUrl: 'kutya', credentials: { client_id: 'cid', client_secret: 'csec' },
      routes: [
        { url: `https://${SHOP}/admin/oauth/access_token`, method: 'POST', times: 1, body: { access_token: 'shpat_new1', scope: 'read_orders', expires_in: 86399 } },
        { url: GRAPHQL, times: 1, body: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } } } } },
        { url: GRAPHQL, times: 1, body: gql({ shop: { name: 'Kutya Bolt', myshopifyDomain: SHOP } }) },
        { url: GRAPHQL, times: 1, status: 401, body: { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' } },
        { url: `https://${SHOP}/admin/oauth/access_token`, method: 'POST', times: 1, body: { access_token: 'shpat_new2', scope: 'read_orders', expires_in: 86399 } },
        { url: GRAPHQL, body: gql({ shop: { name: 'Kutya Bolt', myshopifyDomain: SHOP } }) },
      ],
    });
    assert.equal(await client.test(), `Kapcsolat rendben: Kutya Bolt (${SHOP}).`);
    const tokenReq = requests[0];
    assert.equal(tokenReq.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(tokenReq.body, 'grant_type=client_credentials&client_id=cid&client_secret=csec');
    assert.equal(requests[1].headers['x-shopify-access-token'], 'shpat_new1');
    assert.equal(requests.length, 3, 'throttled once, then answered');
    assert.equal(store.value.token, 'shpat_new1');
    await client.test();
    assert.deepEqual(requests.slice(3).map((r) => [r.url.split('/').pop(), r.headers['x-shopify-access-token']]),
      [['graphql.json', 'shpat_new1'], ['access_token', undefined], ['graphql.json', 'shpat_new2']]);
    assert.ok(requests.every((r) => !r.unmatched));
  });

  test('shopify: refused token and invalid shop address', async () => {
    const { client } = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 'bad' },
      routes: [{ url: GRAPHQL, status: 401, body: { errors: '[API] Invalid API key or access token' } }],
    });
    await assert.rejects(client.test(), (e) => e instanceof WebshopError && e.kind === 'auth' && /401/.test(e.message));
    assert.throws(() => adapter(shopify.platform, { shopUrl: 'https://kutyabolt.hu', credentials: { access_token: 't' } }), (e) => e.kind === 'config');
    const none = adapter(shopify.platform, { shopUrl: SHOP, credentials: {} });
    await assert.rejects(none.client.test(), (e) => e.kind === 'config');
  });

  test('shopify: fulfilment per location with tracking info', async () => {
    const fo = (id, loc, actions = ['CREATE_FULFILLMENT', 'HOLD']) => ({ id: `gid://shopify/FulfillmentOrder/${id}`, status: 'OPEN', assignedLocation: { location: { id: `gid://shopify/Location/${loc}` } }, supportedActions: actions.map((action) => ({ action })) });
    const { client, requests } = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 't' },
      routes: [
        { url: GRAPHQL, bodyIncludes: 'FlFulfillmentOrders', body: gql({ order: { id: 'gid://shopify/Order/555001', displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { nodes: [fo(1, 10), fo(2, 10), fo(3, 20), { ...fo(4, 10, []), status: 'CLOSED' }] } } }) },
        { url: GRAPHQL, bodyIncludes: 'FlFulfillmentCreate', body: gql({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS' }, userErrors: [] } }) },
      ],
    });
    const out = await client.fulfill({ remoteId: 'gid://shopify/Order/555001', trackingNumbers: ['00123456789'], trackingUrls: ['https://gls-group.com/HU/hu/csomagkovetes?match=00123456789'], carrierCode: 'gls', carrierName: 'GLS' });
    assert.equal(out.message, 'Teljesítve a Shopifyban.');
    assert.deepEqual(json(requests[0]).variables, { id: 'gid://shopify/Order/555001' });
    const creates = requests.filter((r) => r.body.includes('FlFulfillmentCreate')).map((r) => json(r).variables.fulfillment);
    assert.deepEqual(creates, [
      { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1' }, { fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/2' }], notifyCustomer: true,
        trackingInfo: { company: 'GLS', number: '00123456789', url: 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789' } },
      { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/3' }], notifyCustomer: true,
        trackingInfo: { company: 'GLS', number: '00123456789', url: 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789' } },
    ]);

    const done = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 't' }, settings: { notify_customer: false },
      routes: [{ url: GRAPHQL, bodyIncludes: 'FlFulfillmentOrders', body: gql({ order: { id: 'x', displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { nodes: [{ ...fo(1, 10, []), status: 'CLOSED' }] } } }) }],
    });
    assert.equal((await done.client.fulfill({ remoteId: 'x', trackingNumbers: [], trackingUrls: [], carrierCode: '', carrierName: '' })).already, true);
    assert.equal(done.requests.length, 1, 'no mutation for a fulfilled order');

    const refused = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 't' },
      routes: [
        { url: GRAPHQL, bodyIncludes: 'FlFulfillmentOrders', body: gql({ order: { id: 'x', displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { nodes: [fo(1, 10)] } } }) },
        { url: GRAPHQL, bodyIncludes: 'FlFulfillmentCreate', body: gql({ fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['fulfillment'], message: 'Fulfillment order is on hold.' }] } }) },
      ],
    });
    await assert.rejects(refused.client.fulfill({ remoteId: 'x', trackingNumbers: [], trackingUrls: [], carrierCode: '', carrierName: '' }), /on hold/);
  });

  test('shopify: stock sync sets available quantities at the location', async () => {
    const { client, requests } = adapter(shopify.platform, {
      shopUrl: SHOP, credentials: { access_token: 't' }, settings: { stock_location_id: '777' },
      routes: [
        { url: GRAPHQL, bodyIncludes: 'FlVariants', body: gql({ productVariants: { nodes: [{ sku: 'KB-1001', inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true } }, { sku: 'KB-10011', inventoryItem: { id: 'gid://shopify/InventoryItem/9', tracked: true } }] } }) },
        { url: GRAPHQL, bodyIncludes: 'FlSetStock', body: gql({ inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'g' }, userErrors: [] } }) },
      ],
    });
    const out = await client.pushStock([{ sku: 'KB-1001', qty: 48 }, { sku: 'KB-1002', qty: 3 }]);
    assert.deepEqual(out, { updated: ['KB-1001'], missing: ['KB-1002'], failed: [] });
    assert.deepEqual(json(requests[0]).variables, { query: 'sku:"KB-1001" OR sku:"KB-1002"' });
    const set = json(requests[1]);
    assert.match(set.query, /inventorySetQuantities\(input: \$input\) @idempotent\(key: "[0-9a-f-]{36}"\)/);
    assert.deepEqual(set.variables.input, { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/777', quantity: 48, changeFromQuantity: null }] });
    const noLocation = adapter(shopify.platform, { shopUrl: SHOP, credentials: { access_token: 't' } });
    await assert.rejects(noLocation.client.pushStock([{ sku: 'A', qty: 1 }]), (e) => e.kind === 'config');
  });

  test('woocommerce: orders request, documentation example, Hungarian COD pickup order, pagination', async () => {
    const BASE = 'https://bolt.example.hu/wp-json/wc/v3/orders';
    const { client, requests, logs } = adapter(woocommerce.platform, {
      shopUrl: 'bolt.example.hu/', credentials: { consumer_key: 'ck_abc', consumer_secret: 'cs_secret' }, settings: { ignore_skus: 'GIFT' },
      routes: [{ url: BASE, headers: { 'content-type': 'application/json', 'x-wp-total': '4', 'x-wp-totalpages': '2' },
        body: [WOO_727, WOO_HU, { ...WOO_727, id: 728, status: 'cancelled' }, { ...WOO_727, id: 729, status: 'completed' }] }],
    });
    const { orders, nextPage } = await client.listOrders({ since: SINCE, page: null });
    assert.equal(nextPage, 2);
    const u = new URL(requests[0].url);
    assert.equal(u.origin + u.pathname, BASE);
    assert.deepEqual(Object.fromEntries(u.searchParams), { modified_after: '2026-10-14T23:59:59', dates_are_gmt: 'true', orderby: 'modified', order: 'asc', per_page: '50', page: '1' });
    assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('ck_abc:cs_secret').toString('base64')}`);

    const [doc, hu, cancelled, completed] = orders;
    assert.equal(doc.state, 'import');
    assert.equal(doc.remoteId, '727');
    assert.equal(doc.updatedAt, '2017-03-22T19:28:08.000Z');
    assert.equal(doc.input.customer_name, 'John Doe');
    assert.equal(doc.input.country, 'US');
    assert.equal(doc.input.cod_amount, 0, 'bank transfer');
    assert.deepEqual(doc.lines, [{ sku: 'Bar3', qty: 1, external_line_id: '316' }]);
    assert.match(doc.problems[0], /Woo Single #1.*nincs cikkszáma/, 'the documented line without SKU is a problem');

    assert.deepEqual(hu.input, {
      customer_name: 'Kiss Anna', company: 'Kiss Bt.', email: 'anna@example.com', phone: '+36301112222', country: 'HU', zip: '1111', city: 'Budapest',
      address: 'Fő utca 1., 3. ajtó', pickup_point_id: 'HU-CS-1185', carrier_code: 'mpl', carrier_service: 'CS', cod_amount: 15990, currency: 'HUF',
      note: 'Délután legyen kint.', ordered_at: '2026-10-15T07:00:00.000Z',
    });
    assert.deepEqual(hu.lines, [{ sku: 'KB-1001', qty: 2, external_line_id: '901' }], 'ignored SKU dropped');
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual([completed.state, completed.reason], ['skip', 'Állapot: completed.']);
    assert.ok(logs.every((l) => !JSON.stringify(l).includes('cs_secret')));
  });

  test('woocommerce: query string authentication and refused keys', async () => {
    const { client, requests, logs } = adapter(woocommerce.platform, {
      shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck_abc', consumer_secret: 'cs_secret' }, settings: { query_auth: true },
      routes: [{ urlIncludes: '/wc/v3/orders', status: 401, body: { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } } }],
    });
    await assert.rejects(client.test(), (e) => e.kind === 'auth' && /woocommerce_rest_cannot_view/.test(e.message));
    const u = new URL(requests[0].url);
    assert.equal(u.searchParams.get('consumer_key'), 'ck_abc');
    assert.equal(u.searchParams.get('consumer_secret'), 'cs_secret');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.ok(logs.every((l) => !l.message.includes('cs_secret')), 'query strings are not logged');
    assert.throws(() => adapter(woocommerce.platform, { shopUrl: 'http://bolt.example.hu', credentials: { consumer_key: 'a', consumer_secret: 'b' } }), /HTTPS/);
  });

  test('woocommerce: fulfilment with shipment tracking, customer note and completion, idempotent', async () => {
    const O = 'https://bolt.example.hu/wp-json/wc/v3/orders/812';
    const T = 'https://bolt.example.hu/wp-json/wc-shipment-tracking/v3/orders/812/shipment-trackings';
    const f = { remoteId: '812', trackingNumbers: ['00123456789'], trackingUrls: ['https://gls-group.com/HU/hu/csomagkovetes?match=00123456789'], carrierCode: 'gls', carrierName: 'GLS' };
    const { client, requests } = adapter(woocommerce.platform, {
      shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck', consumer_secret: 'cs' }, settings: { shipment_tracking: true },
      routes: [
        { method: 'GET', url: O, body: { ...WOO_HU } },
        { method: 'GET', url: T, body: [] },
        { method: 'POST', url: T, status: 201, body: { tracking_id: 'abc' } },
        { method: 'GET', url: `${O}/notes`, body: [] },
        { method: 'POST', url: `${O}/notes`, status: 201, body: { id: 1 } },
        { method: 'PUT', url: O, body: { ...WOO_HU, status: 'completed' } },
      ],
    });
    await client.fulfill(f);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url.replace('https://bolt.example.hu/wp-json/', '')}`), [
      'GET wc/v3/orders/812', 'GET wc-shipment-tracking/v3/orders/812/shipment-trackings', 'POST wc-shipment-tracking/v3/orders/812/shipment-trackings',
      'GET wc/v3/orders/812/notes?type=customer', 'POST wc/v3/orders/812/notes', 'PUT wc/v3/orders/812',
    ]);
    const tracking = json(requests[2]);
    assert.deepEqual(Object.keys(tracking).sort(), ['custom_tracking_link', 'custom_tracking_provider', 'date_shipped', 'tracking_number']);
    assert.equal(tracking.tracking_number, '00123456789');
    assert.equal(tracking.custom_tracking_provider, 'GLS');
    assert.equal(tracking.custom_tracking_link, 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789');
    assert.match(tracking.date_shipped, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(json(requests[4]), { note: 'A csomagodat feladtuk, futár: GLS. Csomagszám: 00123456789 (https://gls-group.com/HU/hu/csomagkovetes?match=00123456789)', customer_note: true });
    assert.deepEqual(json(requests[5]), { status: 'completed' });

    // Run again after a partial failure: nothing is written twice.
    const again = adapter(woocommerce.platform, {
      shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck', consumer_secret: 'cs' }, settings: { shipment_tracking: true },
      routes: [
        { method: 'GET', url: O, body: { ...WOO_HU, status: 'completed' } },
        { method: 'GET', url: T, body: [{ tracking_id: 'abc', tracking_number: '00123456789' }] },
        { method: 'GET', url: `${O}/notes`, body: [{ id: 1, note: 'A csomagodat feladtuk, futár: GLS. Csomagszám: 00123456789 (...)', customer_note: true }] },
      ],
    });
    await again.client.fulfill(f);
    assert.deepEqual(again.requests.map((r) => r.method), ['GET', 'GET', 'GET']);

    const gone = adapter(woocommerce.platform, {
      shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
      routes: [{ method: 'GET', url: O, body: { ...WOO_HU, status: 'refunded' } }],
    });
    await assert.rejects(gone.client.fulfill(f), /refunded/);
  });

  test('woocommerce: stock sync for simple products and variations', async () => {
    const P = 'https://bolt.example.hu/wp-json/wc/v3/products';
    const { client, requests } = adapter(woocommerce.platform, {
      shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck', consumer_secret: 'cs' },
      routes: [
        { method: 'GET', url: P, urlIncludes: 'sku=KB-1001', body: [{ id: 93, sku: 'KB-1001', type: 'simple' }] },
        { method: 'GET', url: P, urlIncludes: 'sku=KB-1002', body: [{ id: 23, sku: 'KB-1002', type: 'variation', parent_id: 22 }] },
        { method: 'GET', url: P, urlIncludes: 'sku=KB-1003', body: [] },
        { method: 'POST', url: `${P}/batch`, body: { update: [{ id: 93, stock_quantity: 5 }] } },
        { method: 'POST', url: `${P}/22/variations/batch`, body: { update: [{ id: 23, stock_quantity: 0 }] } },
      ],
    });
    const out = await client.pushStock([{ sku: 'KB-1001', qty: 5 }, { sku: 'KB-1002', qty: 0 }, { sku: 'KB-1003', qty: 7 }]);
    assert.deepEqual(out, { updated: ['KB-1001', 'KB-1002'], missing: ['KB-1003'], failed: [] });
    assert.deepEqual(json(requests[3]), { update: [{ id: 93, manage_stock: true, stock_quantity: 5 }] });
    assert.deepEqual(json(requests[4]), { update: [{ id: 23, manage_stock: true, stock_quantity: 0 }] });
  });

  test('shoprenter: token, status names, orderExtend request and documentation fixture', async () => {
    const API = 'https://kutyabolt.api2.myshoprenter.hu/api';
    const mplOrder = { ...SR_ORDER, id: 'b3JkZXItb3JkZXJfaWQ9MTcz', innerId: '173', shippingMethodExtension: 'MPLPARCELMACHINE', shippingMethodName: 'MPL csomagautomata (Budapest, Fő utca 1.)', shippingMethodLocalizedName: 'MPL csomagautomata', shippingReceivingPointId: 'HU-CS-1185', paymentMethodCode: 'BANK_TRANSFER', paymentMethodName: 'Átutalás' };
    const otherStatus = { ...SR_ORDER, id: 'b3JkZXItb3JkZXJfaWQ9MTc0', innerId: '174', orderStatus: { href: `https://shopname.api.myshoprenter.hu/orderStatuses/${SR_STATUS_4}` } };
    const { client, requests, store } = adapter(shoprenter.platform, {
      shopUrl: 'https://kutyabolt.shoprenter.hu', credentials: { client_id: 'srid', client_secret: 'srsecret' },
      settings: { import_statuses: 'Függőben', default_carrier: 'gls' },
      routes: [
        { method: 'POST', url: 'https://oauth.app.shoprenter.net/kutyabolt/app/token', body: { token_type: 'Bearer', expires_in: 3600, access_token: 'eyJ.sr.token' } },
        { url: `${API}/orderStatusDescriptions`, body: { items: [
          { name: 'Függőben', orderStatus: { href: `https://shopname.api.myshoprenter.hu/orderStatuses/${SR_STATUS_1}` } },
          { name: 'Teljesítve', orderStatus: { href: `https://shopname.api.myshoprenter.hu/orderStatuses/${SR_STATUS_4}` } },
        ] } },
        { url: `${API}/orderExtend`, body: srPage([SR_ORDER, mplOrder, otherStatus], 0, 2) },
      ],
    });
    const { orders, nextPage } = await client.listOrders({ since: SINCE, page: null });
    assert.equal(nextPage, 1);
    assert.equal(requests[0].body, JSON.stringify({ grant_type: 'client_credentials', client_id: 'srid', client_secret: 'srsecret' }));
    assert.equal(store.value.token, 'eyJ.sr.token');
    const list = new URL(requests[2].url);
    assert.equal(list.origin + list.pathname, `${API}/orderExtend`);
    assert.deepEqual(Object.fromEntries(list.searchParams), { full: '1', limit: '50', page: '0', updatedAtMin: '2026-10-15T01:59:59', excludeAbandonedCart: '1', excludeStorno: '1' });
    for (const r of requests.slice(1)) {
      assert.equal(r.headers.authorization, 'Bearer eyJ.sr.token');
      assert.equal(r.headers['content-type'], 'application/json');
      assert.equal(r.headers.accept, 'application/json');
    }
    const [doc, mpl, other] = orders;
    assert.equal(doc.remoteId, 'b3JkZXItb3JkZXJfaWQ9MTcy');
    assert.equal(doc.externalId, '172');
    assert.equal(doc.updatedAt, '2019-09-06T13:47:59.000Z');
    assert.deepEqual(doc.input, {
      customer_name: 'Test Test', company: '', email: 'test@test.com', phone: '+36201234567', country: 'HU', zip: '4033', city: 'Test', address: 'Test street 11',
      pickup_point_id: '', carrier_code: 'gls', carrier_service: '', cod_amount: 3990, currency: 'HUF', note: 'Comment', ordered_at: '2019-09-06T13:47:59.000Z',
    });
    assert.deepEqual(doc.lines, [{ sku: '997000004', qty: 1, external_line_id: 'b3JkZXJQcm9kdWN0LW9yZGVyX3Byb2R1Y3RfaWQ9MTU3' }, { sku: '99400000', qty: 1, external_line_id: 'b3JkZXJQcm9kdWN0LW9yZGVyX3Byb2R1Y3RfaWQ9MTg1' }]);
    assert.deepEqual([mpl.input.carrier_code, mpl.input.carrier_service, mpl.input.pickup_point_id, mpl.input.cod_amount], ['mpl', 'CS', 'HU-CS-1185', 0]);
    assert.deepEqual([other.state, other.reason], ['skip', 'Állapot: 4.']);
  });

  test('shoprenter: empty result, unknown status, fulfilment by status change', async () => {
    const API = 'https://kutyabolt.api2.myshoprenter.hu/api';
    const empty = adapter(shoprenter.platform, {
      shopUrl: 'kutyabolt', credentials: { client_id: 'a', client_secret: 'b' }, token: { token: 'tok', expiresAt: Date.now() + 3600000 },
      routes: [{ url: `${API}/orderExtend`, status: 400, body: { error: 40008, message: 'Page not found! This Resource minimum page is 0 and maximum page is 0' } }],
    });
    assert.deepEqual(await empty.client.listOrders({ since: SINCE }), { orders: [], nextPage: null });
    assert.equal(empty.requests.length, 1, 'cached token used');

    const unknown = adapter(shoprenter.platform, {
      shopUrl: 'kutyabolt', credentials: { client_id: 'a', client_secret: 'b' }, settings: { import_statuses: 'Nincs ilyen' }, token: { token: 'tok', expiresAt: Date.now() + 3600000 },
      routes: [{ url: `${API}/orderStatusDescriptions`, body: { items: [] } }],
    });
    await assert.rejects(unknown.client.listOrders({ since: SINCE }), (e) => e.kind === 'config' && /Nincs ilyen/.test(e.message));

    const ORDER = `${API}/orders/${encodeURIComponent(SR_ORDER.id)}`;
    const f = { remoteId: SR_ORDER.id, trackingNumbers: ['CS0012345678'], trackingUrls: ['https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=CS0012345678'], carrierCode: 'mpl', carrierName: 'MPL (Magyar Posta)' };
    const ful = adapter(shoprenter.platform, {
      shopUrl: 'kutyabolt', credentials: { client_id: 'a', client_secret: 'b' }, settings: { shipped_status: '4', tracking_in_comment: true }, token: { token: 'tok', expiresAt: Date.now() + 3600000 },
      routes: [{ method: 'GET', url: ORDER, body: SR_ORDER }, { method: 'PUT', url: ORDER, body: SR_ORDER }],
    });
    await ful.client.fulfill(f);
    assert.deepEqual(json(ful.requests[1]), {
      orderStatus: { id: SR_STATUS_4 },
      comment: 'Comment\nCsomagszám (MPL (Magyar Posta)): CS0012345678 https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=CS0012345678',
    });
    const noStatus = adapter(shoprenter.platform, { shopUrl: 'kutyabolt', credentials: { client_id: 'a', client_secret: 'b' } });
    await assert.rejects(noStatus.client.fulfill(f), (e) => e.kind === 'config');
    assert.throws(() => adapter(shoprenter.platform, { shopUrl: 'https://www.kutyabolt.hu', credentials: { client_id: 'a', client_secret: 'b' } }), /rövid nevét/);
  });

  test('unas: login, getOrder request and documentation example', async () => {
    const { client, requests } = adapter(unas.platform, {
      credentials: { api_key: 'unas-secret-key' }, settings: { import_statuses: 'Beérkezett', ignore_skus: '' },
      routes: [
        { method: 'POST', url: 'https://api.unas.eu/shop/login', headers: XML, body: unasLogin() },
        { method: 'POST', url: 'https://api.unas.eu/shop/getOrder', headers: XML, body: UNAS_ORDERS },
      ],
    });
    const { orders, nextPage } = await client.listOrders({ since: SINCE, page: null });
    assert.equal(nextPage, null);
    assert.equal(requests[0].body, '<?xml version="1.0" encoding="UTF-8" ?>\n<Params><ApiKey>unas-secret-key</ApiKey><WebshopInfo>true</WebshopInfo></Params>');
    assert.equal(requests[1].headers.authorization, 'Bearer unas-token-1');
    assert.equal(requests[1].body, `<?xml version="1.0" encoding="UTF-8" ?>\n<Params><TimeModStart>${SINCE.getTime() / 1000 - 1}</TimeModStart><Order>modify_time_asc</Order><LimitNum>100</LimitNum><LimitStart>0</LimitStart></Params>`);
    const [o] = orders;
    assert.equal(o.state, 'import');
    assert.equal(o.remoteId, '1000-1000000');
    assert.equal(o.number, '1000-1000000');
    assert.equal(o.updatedAt, '2012-02-01T09:00:00.000Z');
    assert.deepEqual(o.input, {
      customer_name: 'Teszt János', company: '', email: 'unas@unas.hu', phone: '+36301111111', country: 'HU', zip: '2222', city: 'Teszt Város', address: 'Tej út 10.',
      pickup_point_id: '157547', carrier_code: 'gls', carrier_service: '', cod_amount: 0, currency: 'HUF',
      note: 'Megjegyzés\nA vásárló megjegyzése\nA vásárló megjegyzése a szállító számára', ordered_at: '2012-01-01T09:00:00.000Z',
    });
    assert.deepEqual(o.lines, [{ sku: 'Cikkszam1', qty: 1, external_line_id: '' }, { sku: 'Cikkszam2', qty: 1, external_line_id: '' }], 'discount and shipping cost lines are not goods');

    const unwanted = adapter(unas.platform, {
      credentials: { api_key: 'k' }, token: { token: 't', expiresAt: Date.now() + 3600000 },
      routes: [{ url: 'https://api.unas.eu/shop/getOrder', headers: XML, body: UNAS_ORDERS }],
    });
    const skipped = (await unwanted.client.listOrders({ since: SINCE })).orders[0];
    assert.equal(skipped.state, 'skip', 'without import statuses only open_normal orders come in');
    const cancelled = adapter(unas.platform, {
      credentials: { api_key: 'k' }, settings: { cancel_statuses: '123456' }, token: { token: 't', expiresAt: Date.now() + 3600000 },
      routes: [{ url: 'https://api.unas.eu/shop/getOrder', headers: XML, body: UNAS_ORDERS }],
    });
    assert.equal((await cancelled.client.listOrders({ since: SINCE })).orders[0].state, 'cancelled');
  });

  test('unas: a refused login is never retried, bans are recognised', async () => {
    const bad = adapter(unas.platform, {
      credentials: { api_key: 'wrong' },
      routes: [{ url: 'https://api.unas.eu/shop/login', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Error>Hibás API kulcs</Error>' }],
    });
    await assert.rejects(bad.client.listOrders({ since: SINCE }), (e) => e.kind === 'auth' && /Hibás API kulcs/.test(e.message));
    assert.equal(bad.requests.length, 1);
    const banned = adapter(unas.platform, {
      credentials: { api_key: 'k' }, token: { token: 't', expiresAt: Date.now() + 3600000 },
      routes: [{ url: 'https://api.unas.eu/shop/getOrder', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Error>Too much getOrder query, IP is banned till 02.28.2099 10:00:00</Error>' }],
    });
    await assert.rejects(banned.client.listOrders({ since: SINCE }), (e) => e.kind === 'banned' && e.retryAfter > 3600 * 1000);
  });

  test('unas: setOrder fulfilment and setStock requests', async () => {
    const { client, requests } = adapter(unas.platform, {
      credentials: { api_key: 'k' }, settings: { shipped_status: 'Feladva' }, token: { token: 't', expiresAt: Date.now() + 3600000 },
      routes: [
        { url: 'https://api.unas.eu/shop/setOrder', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Orders><Order><Action>modify</Action><Key>1000-1000000</Key><Status>ok</Status></Order></Orders>' },
        { url: 'https://api.unas.eu/shop/setStock', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Products><Product><Id>1</Id><Sku>KB-1001</Sku><Action>modify</Action><Status>ok</Status></Product><Product><Sku>KB-1002</Sku><Action>modify</Action><Status>error</Status><Error>Nincs ilyen termék</Error></Product></Products>' },
      ],
    });
    await client.fulfill({ remoteId: '1000-1000000', trackingNumbers: ['00123456789'], trackingUrls: ['https://gls-group.com/HU/hu/csomagkovetes?match=00123456789'], carrierCode: 'gls', carrierName: 'GLS' });
    assert.equal(requests[0].body, '<?xml version="1.0" encoding="UTF-8" ?>\n<Orders><Order><Action>modify</Action><Key>1000-1000000</Key><Status>Feladva</Status><StatusEmail>yes</StatusEmail>'
      + '<Shipping><PackageNumber>00123456789</PackageNumber><TrackingUrl>https://gls-group.com/HU/hu/csomagkovetes?match=00123456789</TrackingUrl></Shipping></Order></Orders>');
    const out = await client.pushStock([{ sku: 'KB-1001', qty: 48 }, { sku: 'KB-1002', qty: 0 }]);
    assert.deepEqual(out, { updated: ['KB-1001'], missing: ['KB-1002'], failed: [] });
    assert.equal(requests[1].body, '<?xml version="1.0" encoding="UTF-8" ?>\n<Products><Product><Action>modify</Action><Sku>KB-1001</Sku><Stocks><Stock><Qty>48</Qty></Stock></Stocks></Product>'
      + '<Product><Action>modify</Action><Sku>KB-1002</Sku><Stocks><Stock><Qty>0</Qty></Stock></Stocks></Product></Products>');
    const failed = adapter(unas.platform, {
      credentials: { api_key: 'k' }, token: { token: 't', expiresAt: Date.now() + 3600000 },
      routes: [{ url: 'https://api.unas.eu/shop/setOrder', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Orders><Order><Key>1</Key><Status>error</Status><Error>Nem létező rendelés</Error></Order></Orders>' }],
    });
    await assert.rejects(failed.client.fulfill({ remoteId: '1', trackingNumbers: ['X'], trackingUrls: [''], carrierCode: '', carrierName: '' }), /Nem létező rendelés/);
  });
});

// ======================================================================== sync engine (Worker)

describe('sync engine (Worker, D1)', () => {
  let srv;
  let fx;
  const ok = (r) => {
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  const q = (sql, ...args) => srv.query(sql, ...args);
  const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

  async function connection({ id, partner, platform, shopUrl, credentials, settings = {}, cursor = '{"since":"2026-10-15T00:00:00.000Z"}' }) {
    const enc = ok(await srv.call('crypto.encryptJson', [credentials]));
    await srv.sql(`INSERT INTO webshop_connections (id, partner_id, platform, shop_url, credentials, settings, active, last_sync_cursor)
      VALUES (${id}, ${partner}, '${platform}', ${sqlText(shopUrl)}, '${enc}', ${sqlText(JSON.stringify(settings))}, 1, ${sqlText(cursor)})`);
  }
  async function setCredentials(id, credentials) {
    const enc = ok(await srv.call('crypto.encryptJson', [credentials]));
    await srv.sql(`UPDATE webshop_connections SET credentials = '${enc}' WHERE id = ${id}`);
  }
  async function mocked(call, args, routes, budget) {
    const r = ok(await srv.call('webshops.runWithMockedHttp', [{ call, args, routes, budget }]));
    assert.deepEqual(r.requests.filter((x) => x.unmatched).map((x) => `${x.method} ${x.url}`), [], 'every request was expected');
    return r;
  }
  const orderOf = async (externalId, source = 'shopify') => (await q('SELECT * FROM orders WHERE external_id = ? AND source = ?', externalId, source))[0];
  const events = async (orderId) => (await q("SELECT type, text FROM order_events WHERE order_id = ? ORDER BY id", orderId));

  // Shopify connection 1 (Kutyabarát): four orders over two pages, one with an unknown SKU.
  const S1 = shopifyOrder(1, { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(11, 'KB-1001', 2), lineNode(12, 'KB-1003', 1)] } });
  const S2 = shopifyOrder(2, {
    displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Cash on Delivery (COD)'], totalOutstandingSet: { presentmentMoney: { amount: '12990.0', currencyCode: 'HUF' } },
    customAttributes: [{ key: 'foxpost_apm', value: 'HU1234' }], shippingLine: { title: 'Foxpost automata', code: 'fox' },
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(21, 'KB-1002', 1)] },
  });
  const S3 = shopifyOrder(3, { lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(31, 'KB-1001', 1), lineNode(32, 'KB-9999', 1)] } });
  const S4 = shopifyOrder(4, { cancelledAt: '2026-10-15T09:04:00Z' });
  const shopifyPages = (p1, p2) => [
    { url: GRAPHQL, bodyIncludes: '"after":"c1"', body: ordersPage(p2) },
    { url: GRAPHQL, bodyIncludes: 'FlOrders', body: ordersPage(p1, p2 ? 'c1' : null) },
  ];

  before(async () => {
    srv = await startServer();
    await srv.admin();
    fx = await srv.seedBasics();
    await connection({ id: 1, partner: fx.clients.kutya, platform: 'shopify', shopUrl: SHOP, credentials: { access_token: 'shpat_good' },
      settings: { carrier_map: 'GLS házhozszállítás=gls', pickup_point_attribute: 'foxpost_apm', initial_days: 1 } });
  });
  after(async () => { await srv.stop(); });

  test('listPlatforms describes the four platforms for the connection form', async () => {
    const platforms = ok(await srv.call('webshops.listPlatforms'));
    assert.deepEqual(platforms.map((p) => p.code), ['shopify', 'woocommerce', 'shoprenter', 'unas']);
    for (const p of platforms) {
      assert.ok(p.name && p.shopUrl && p.shopUrl.label);
      for (const f of [...p.credentialFields, ...p.settingFields]) {
        assert.ok(f.key && f.label, `${p.code}.${f.key}`);
        assert.ok(['text', 'password', 'select', 'number', 'checkbox'].includes(f.type), `${p.code}.${f.key} type`);
        if (f.type === 'select') assert.ok(Array.isArray(f.options) && f.options.length);
      }
      assert.ok(p.settingFields.some((f) => f.key === 'stock_sync'), 'stock sync option');
      assert.ok(p.settingFields.some((f) => f.key === 'carrier_map'));
      assert.ok(p.settingFields.some((f) => f.key === 'cod_methods'));
    }
  });

  test('import: orders become createOrder orders, unknown SKU waits with a clear error, cursor moves', async () => {
    const { result, requests } = await mocked('syncConnection', [1], shopifyPages([S1, S2], [S3, S4]));
    assert.deepEqual({ imported: result.imported, skipped: result.skipped, errors: result.errors }, { imported: 2, skipped: 1, errors: ['#1003: Ismeretlen cikkszám: KB-9999'] });
    assert.equal(requests.length, 2);
    assert.equal(json(requests[0]).variables.query, "updated_at:>='2026-10-15T00:00:00Z'");

    const o1 = await orderOf('555001');
    assert.equal(o1.partner_id, fx.clients.kutya);
    assert.equal(o1.status, 'new');
    assert.equal(o1.external_number, '#1001');
    assert.equal(o1.carrier_id, fx.carriers.gls);
    assert.equal(o1.address, 'Fő utca 1., 2. emelet');
    assert.equal(o1.cod_amount, 0);
    const lines1 = await q('SELECT product_id, qty, external_line_id FROM order_lines WHERE order_id = ? ORDER BY id', o1.id);
    assert.deepEqual(lines1, [{ product_id: fx.products.tap, qty: 2, external_line_id: '11' }, { product_id: fx.products.csont, qty: 1, external_line_id: '12' }]);
    const o2 = await orderOf('555002');
    assert.equal(o2.carrier_id, fx.carriers.foxpost);
    assert.equal(o2.pickup_point_id, 'HU1234');
    assert.equal(o2.cod_amount, 12990);
    assert.deepEqual((await events(o1.id)).map((e) => e.text), ['Rendelés importálva a Shopifyból']);

    const map = await q('SELECT order_id, connection_id, remote_id, remote_number FROM webshop_orders ORDER BY order_id');
    assert.deepEqual(map.map((m) => [m.connection_id, m.remote_id, m.remote_number]), [[1, 'gid://shopify/Order/555001', '#1001'], [1, 'gid://shopify/Order/555002', '#1002']]);
    const pending = await q('SELECT remote_id, external_number, error, attempts FROM webshop_pending_orders');
    assert.deepEqual(pending, [{ remote_id: 'gid://shopify/Order/555003', external_number: '#1003', error: 'Ismeretlen cikkszám: KB-9999', attempts: 1 }]);
    const [conn] = await q('SELECT last_sync_at, last_sync_cursor, last_error FROM webshop_connections WHERE id = 1');
    assert.ok(conn.last_sync_at);
    assert.deepEqual(JSON.parse(conn.last_sync_cursor), { since: '2026-10-15T09:04:00.000Z' }, 'the last processed order');
    assert.match(conn.last_error, /1 rendelés nem importálható.*#1003: Ismeretlen cikkszám: KB-9999/);
    const logs = await q("SELECT system, direction, partner_id, action, ok, status, message FROM integration_log WHERE system = 'shopify'");
    assert.equal(logs.length, 2);
    assert.ok(logs.every((l) => l.direction === 'out' && l.partner_id === fx.clients.kutya && l.ok === 1 && l.action === 'orders.list'));
    assert.ok(logs.every((l) => !l.message.includes('shpat_good')));
    assert.equal((await q("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'order' AND actor = 'Rendszer'"))[0].n, 2);
  });

  test('import: reading the same orders again is safe, the pending order is retried once the SKU exists', async () => {
    const before = (await q("SELECT COUNT(*) AS n FROM orders WHERE source = 'shopify'"))[0].n;
    const first = await mocked('syncConnection', [1], shopifyPages([S1, S2], [S4]));
    assert.equal(first.result.imported, 0);
    assert.equal(first.result.skipped, 3);
    assert.equal((await q("SELECT COUNT(*) AS n FROM orders WHERE source = 'shopify'"))[0].n, before, 'no duplicates');
    assert.equal((await q('SELECT attempts FROM webshop_pending_orders'))[0].attempts, 1, 'not retried before its time');

    await srv.sql("INSERT INTO products (id, partner_id, sku, name) VALUES (1009, 101, 'KB-9999', 'Új cikk'); UPDATE webshop_pending_orders SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    const second = await mocked('syncConnection', [1], shopifyPages([S1, S2], [S3, S4]));
    assert.deepEqual({ imported: second.result.imported, skipped: second.result.skipped, errors: second.result.errors }, { imported: 1, skipped: 4, errors: [] });
    const o3 = await orderOf('555003');
    assert.equal((await q('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?', o3.id))[0].n, 2);
    assert.equal((await q('SELECT COUNT(*) AS n FROM webshop_pending_orders'))[0].n, 0);
    assert.equal((await q('SELECT last_error FROM webshop_connections WHERE id = 1'))[0].last_error, '');
  });

  test('import: an order cancelled in the shop is cancelled here while new, otherwise flagged', async () => {
    const o1 = await orderOf('555001');
    const o2 = await orderOf('555002');
    await srv.sql(`UPDATE orders SET status = 'picking' WHERE id = ${o2.id}`);
    const { result } = await mocked('syncConnection', [1], shopifyPages([
      { ...S1, cancelledAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z' },
      { ...S2, cancelledAt: '2026-10-15T10:01:00Z', updatedAt: '2026-10-15T10:01:00Z' },
    ]));
    assert.equal(result.cancelled, 1);
    assert.equal((await orderOf('555001')).status, 'cancelled');
    assert.deepEqual((await events(o1.id)).map((e) => e.text).slice(-1), ['Sztornózva: a rendelést törölték a webshopban (Shopify).']);
    assert.equal((await orderOf('555002')).status, 'picking');
    assert.match((await events(o2.id)).slice(-1)[0].text, /törölték a webshopban \(Shopify\), de már „Komissió alatt” állapotú/);
    // Seen once: reading them again changes nothing.
    await mocked('syncConnection', [1], shopifyPages([
      { ...S1, cancelledAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z' },
      { ...S2, cancelledAt: '2026-10-15T10:01:00Z', updatedAt: '2026-10-15T10:01:00Z' },
    ]));
    assert.equal((await events(o2.id)).filter((e) => /törölték a webshopban/.test(e.text)).length, 1);
  });

  const FO_ROUTE = { url: GRAPHQL, bodyIncludes: 'FlFulfillmentOrders', body: gql({ order: { id: 'x', displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { nodes: [
    { id: 'gid://shopify/FulfillmentOrder/31', status: 'OPEN', assignedLocation: { location: { id: 'gid://shopify/Location/1' } }, supportedActions: [{ action: 'CREATE_FULFILLMENT' }] },
  ] } } }) };
  const CREATE_OK = { url: GRAPHQL, bodyIncludes: 'FlFulfillmentCreate', body: gql({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS' }, userErrors: [] } }) };

  test('fulfilment: shipped orders are reported back with tracking number, carrier and tracking URL', async () => {
    const o3 = await orderOf('555003');
    await srv.sql(`UPDATE orders SET status = 'shipped', shipped_at = '2026-10-16T12:00:00.000Z', tracking_number = '00123456789', carrier_id = ${fx.carriers.gls} WHERE id = ${o3.id};
      INSERT INTO orders (id, number, partner_id, source, customer_name, status) VALUES (9001, 'R-2026-900001', 101, 'manual', 'Kézi Rendelés', 'shipped')`);
    const { result, requests } = await mocked('pushFulfillments', [[o3.id, 9001]], [FO_ROUTE, CREATE_OK]);
    assert.equal(result.fulfilled, 1);
    assert.equal(requests.length, 2, 'the manual order is not a webshop order');
    assert.deepEqual(json(requests[0]).variables, { id: 'gid://shopify/Order/555003' });
    assert.deepEqual(json(requests[1]).variables.fulfillment, {
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/31' }], notifyCustomer: true,
      trackingInfo: { company: 'GLS', number: '00123456789', url: 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789' },
    });
    assert.ok((await orderOf('555003')).fulfillment_synced_at);
    assert.equal((await events(o3.id)).slice(-1)[0].text, 'Feladás visszaküldve a webshopba (Shopify), csomagszám: 00123456789.');
    const again = await mocked('pushFulfillments', [[o3.id]], []);
    assert.equal(again.requests.length, 0, 'already synced');
  });

  test('fulfilment: a refused push is recorded and retried by the next sync', async () => {
    const o2 = await orderOf('555002');
    await srv.sql(`UPDATE orders SET status = 'shipped', shipped_at = '2026-10-16T12:00:00.000Z', tracking_number = 'FOX123' WHERE id = ${o2.id}`);
    const refused = { url: GRAPHQL, bodyIncludes: 'FlFulfillmentCreate', body: gql({ fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['fulfillment'], message: 'Fulfillment order is on hold.' }] } }) };
    const first = await mocked('pushFulfillments', [[o2.id]], [FO_ROUTE, refused]);
    assert.equal(first.result.fulfilled, 0);
    assert.match(first.result.errors[0], /on hold/);
    const [w] = await q('SELECT fulfillment_attempts, fulfillment_error, fulfillment_next_at FROM webshop_orders WHERE order_id = ?', o2.id);
    assert.equal(w.fulfillment_attempts, 1);
    assert.match(w.fulfillment_error, /on hold/);
    assert.ok(w.fulfillment_next_at > new Date().toISOString());
    assert.match((await events(o2.id)).slice(-1)[0].text, /Nem sikerült visszaküldeni a feladást a webshopba: Shopify: Fulfillment order is on hold\. Később újrapróbáljuk\./);

    const early = await mocked('syncConnection', [1], shopifyPages([]));
    assert.equal(early.result.fulfilled, 0, 'waits for the backoff');
    await srv.sql(`UPDATE webshop_orders SET fulfillment_next_at = '2000-01-01T00:00:00.000Z' WHERE order_id = ${o2.id}`);
    const later = await mocked('syncConnection', [1], [...shopifyPages([]), FO_ROUTE, CREATE_OK]);
    assert.equal(later.result.fulfilled, 1);
    const create = later.requests.find((r) => r.body.includes('FlFulfillmentCreate'));
    assert.deepEqual(json(create).variables.fulfillment.trackingInfo, { company: 'Foxpost', number: 'FOX123', url: 'https://foxpost.hu/csomagkovetes/?code=FOX123' });
    assert.ok((await orderOf('555002')).fulfillment_synced_at);
  });

  test('budget: a run stops gracefully and the next one continues from the last processed order', async () => {
    await connection({ id: 2, partner: fx.clients.konyha, platform: 'shopify', shopUrl: 'konyha.myshopify.com', credentials: { access_token: 'shpat_konyha' } });
    const K = 'https://konyha.myshopify.com/admin/api/2026-10/graphql.json';
    const nodes = [1, 2, 3, 4, 5].map((n) => shopifyOrder(n, { id: `gid://shopify/Order/77700${n}`, legacyResourceId: `77700${n}`, lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineNode(n, 'KG-2002', 1)] } }));
    const small = await mocked('syncConnection', [2], [{ url: K, body: ordersPage(nodes) }], 90);
    assert.equal(small.result.partial, true);
    assert.ok(small.result.imported >= 1 && small.result.imported < 5, `imported ${small.result.imported}`);
    const cursor = JSON.parse((await q('SELECT last_sync_cursor FROM webshop_connections WHERE id = 2'))[0].last_sync_cursor);
    assert.equal(cursor.since, nodes[small.result.imported - 1].updatedAt.replace('Z', '.000Z'));
    const rest = await mocked('syncConnection', [2], [{ url: K, body: ordersPage(nodes) }]);
    assert.equal(rest.result.imported, 5 - small.result.imported);
    assert.equal((await q("SELECT COUNT(*) AS n FROM orders WHERE partner_id = 102 AND source = 'shopify'"))[0].n, 5);
  });

  test('paused connections: refused credentials stop the cron until they change, locks prevent overlap', async () => {
    await setCredentials(2, { access_token: 'shpat_revoked' });
    const K = 'https://konyha.myshopify.com/admin/api/2026-10/graphql.json';
    const refused = await mocked('syncConnection', [2], [{ url: K, status: 401, body: { errors: '[API] Invalid API key or access token' } }]);
    assert.match(refused.result.errors[0], /401/);
    const [st] = await q('SELECT backoff_until, failed_credentials FROM webshop_connection_state WHERE connection_id = 2');
    assert.ok(st.backoff_until > new Date().toISOString());
    assert.match(st.failed_credentials, /^[0-9a-f]{64}$/);
    assert.match((await q('SELECT last_error FROM webshop_connections WHERE id = 2'))[0].last_error, /401/);

    // The cron skips it (connection 1 still runs), a changed key runs again and clears the pause.
    const cron = await mocked('syncAll', [], shopifyPages([]));
    assert.ok(cron.requests.every((r) => r.url.startsWith(`https://${SHOP}/`)));
    const skippedRun = cron.result.find((r) => r.id === 2);
    assert.match(skippedRun.errors[0], /szünetel/);
    await setCredentials(2, { access_token: 'shpat_new' });
    const fixed = await mocked('syncAll', [], [...shopifyPages([]), { url: K, body: ordersPage([]) }]);
    assert.deepEqual(fixed.result.find((r) => r.id === 2).errors, []);
    assert.equal((await q('SELECT backoff_until FROM webshop_connection_state WHERE connection_id = 2'))[0].backoff_until, null);

    await srv.sql("UPDATE webshop_connection_state SET lock_until = '2099-01-01T00:00:00.000Z' WHERE connection_id = 2");
    const locked = await mocked('syncConnection', [2], []);
    assert.match(locked.result.errors[0], /már fut egy szinkron/);
    assert.equal(locked.requests.length, 0);
    await srv.sql('UPDATE webshop_connection_state SET lock_until = NULL WHERE connection_id = 2');
  });

  test('testConnection answers ok or the problem', async () => {
    const good = await mocked('testConnection', [1], [{ url: GRAPHQL, body: gql({ shop: { name: 'Kutyabarát', myshopifyDomain: SHOP } }) }]);
    assert.deepEqual(good.result, { ok: true, message: `Kapcsolat rendben: Kutyabarát (${SHOP}).` });
    const bad = await mocked('testConnection', [1], [{ url: GRAPHQL, status: 403, body: { errors: 'Forbidden' } }]);
    assert.equal(bad.result.ok, false);
    assert.match(bad.result.message, /403/);
    await srv.sql("DELETE FROM webshop_connection_state WHERE connection_id = 1");
    const missing = ok(await srv.call('webshops.testConnection', [999]));
    assert.deepEqual(missing, { ok: false, message: 'A webshop kapcsolat nem található.' });
  });

  test('woocommerce: import, a second shop with the same order ids, completion with a customer note', async () => {
    const order = { ...WOO_HU, id: 727, number: '727', meta_data: [], shipping_lines: [{ id: 1, method_title: 'GLS futár', method_id: 'flat_rate' }], line_items: [{ id: 1, name: 'Tap', quantity: 1, sku: 'KB-1002' }] };
    const list = (host) => ({ url: `https://${host}/wp-json/wc/v3/orders`, headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' }, body: [order] });
    await connection({ id: 5, partner: fx.clients.kutya, platform: 'woocommerce', shopUrl: 'https://bolt.example.hu', credentials: { consumer_key: 'ck_1', consumer_secret: 'cs_1' } });
    await connection({ id: 6, partner: fx.clients.kutya, platform: 'woocommerce', shopUrl: 'https://bolt.example.sk', credentials: { consumer_key: 'ck_2', consumer_secret: 'cs_2' } });
    const one = await mocked('syncConnection', [5], [list('bolt.example.hu')]);
    const two = await mocked('syncConnection', [6], [list('bolt.example.sk')]);
    assert.equal(one.result.imported, 1);
    assert.equal(two.result.imported, 1, 'same WooCommerce id in another shop is another order');
    const rows = await q("SELECT o.external_id, o.carrier_id, w.connection_id FROM orders o JOIN webshop_orders w ON w.order_id = o.id WHERE o.source = 'woocommerce' ORDER BY o.id");
    assert.deepEqual(rows.map((r) => [r.external_id, r.connection_id]), [['727', 5], ['727@6', 6]]);
    assert.equal(rows[0].carrier_id, fx.carriers.gls, 'carrier recognised from the method name');
    const again = await mocked('syncConnection', [6], [list('bolt.example.sk')]);
    assert.equal(again.result.imported, 0);

    const o = (await q("SELECT id FROM orders WHERE external_id = '727' AND source = 'woocommerce'"))[0];
    await srv.sql(`UPDATE orders SET status = 'shipped', tracking_number = '00123456789', carrier_id = ${fx.carriers.gls} WHERE id = ${o.id}`);
    const O = 'https://bolt.example.hu/wp-json/wc/v3/orders/727';
    const push = await mocked('pushFulfillments', [[o.id]], [
      { method: 'GET', url: O, body: order },
      { method: 'GET', url: `${O}/notes`, body: [] },
      { method: 'POST', url: `${O}/notes`, status: 201, body: { id: 5 } },
      { method: 'PUT', url: O, body: { ...order, status: 'completed' } },
    ]);
    assert.equal(push.result.fulfilled, 1);
    assert.deepEqual(json(push.requests[2]), { note: 'A csomagodat feladtuk, futár: GLS. Csomagszám: 00123456789 (https://gls-group.com/HU/hu/csomagkovetes?match=00123456789)', customer_note: true });
    assert.deepEqual(json(push.requests[3]), { status: 'completed' });
  });

  test('shoprenter: import of the documentation order and status change on shipping', async () => {
    await srv.sql("INSERT INTO products (id, partner_id, sku, name) VALUES (1010, 101, '997000004', 'Karkötő'), (1011, 101, '99400000', 'Borotva')");
    await connection({ id: 7, partner: fx.clients.kutya, platform: 'shoprenter', shopUrl: 'kutyabolt', credentials: { client_id: 'srid', client_secret: 'srsecret' },
      settings: { import_statuses: '1', shipped_status: '4', default_carrier: 'gls' } });
    const API = 'https://kutyabolt.api2.myshoprenter.hu/api';
    const TOKEN = { method: 'POST', url: 'https://oauth.app.shoprenter.net/kutyabolt/app/token', body: { token_type: 'Bearer', expires_in: 3600, access_token: 'sr-token' } };
    const r = await mocked('syncConnection', [7], [TOKEN, { url: `${API}/orderExtend`, body: srPage([SR_ORDER]) }]);
    assert.deepEqual([r.result.imported, r.result.errors], [1, []]);
    const o = await orderOf('172', 'shoprenter');
    assert.equal(o.cod_amount, 3990);
    assert.equal(o.carrier_id, fx.carriers.gls);
    // Unsorted platform: after a complete pass the cursor moves to the pass start (minus overlap).
    const cursor = JSON.parse((await q('SELECT last_sync_cursor FROM webshop_connections WHERE id = 7'))[0].last_sync_cursor);
    assert.ok(Date.parse(cursor.since) > Date.now() - 11 * 60 * 1000 && Date.parse(cursor.since) < Date.now());
    assert.ok(r.requests.some((x) => x.url.includes('orderExtend')));

    await srv.sql(`UPDATE orders SET status = 'shipped', tracking_number = 'GLS77' WHERE id = ${o.id}`);
    const ORDER = `${API}/orders/${encodeURIComponent(SR_ORDER.id)}`;
    const push = await mocked('pushFulfillments', [[o.id]], [{ method: 'GET', url: ORDER, body: SR_ORDER }, { method: 'PUT', url: ORDER, body: SR_ORDER }]);
    assert.equal(push.result.fulfilled, 1);
    assert.equal(push.requests.length, 2, 'the cached token is reused');
    assert.deepEqual(json(push.requests[1]), { orderStatus: { id: SR_STATUS_4 } });
  });

  test('unas: import, fulfilment, stock sync of changes only, refused key not retried', async () => {
    await connection({ id: 3, partner: fx.clients.kutya, platform: 'unas', shopUrl: 'https://teszt.unas.hu', credentials: { api_key: 'unas-good' },
      settings: { import_statuses: 'Beérkezett', shipped_status: 'Feladva', status_email: false } });
    const LOGIN = { url: 'https://api.unas.eu/shop/login', headers: XML, body: unasLogin() };
    const ORDERS = { url: 'https://api.unas.eu/shop/getOrder', headers: XML, body: UNAS_ORDERS.replace('Cikkszam1', 'KB-1001').replace('Cikkszam2', 'KB-1002') };
    const r = await mocked('syncConnection', [3], [LOGIN, ORDERS]);
    assert.deepEqual([r.result.imported, r.result.errors], [1, []]);
    const o = await orderOf('1000-1000000', 'unas');
    assert.equal(o.pickup_point_id, '157547');
    assert.equal(o.carrier_id, fx.carriers.gls);
    assert.equal(o.customer_name, 'Teszt János');
    const second = await mocked('syncConnection', [3], [ORDERS]);
    assert.equal(second.requests.length, 1, 'the token is cached (UNAS limits logins)');
    assert.equal(second.result.skipped, 1);

    await srv.sql(`UPDATE orders SET status = 'shipped', tracking_number = '00123456789', carrier_id = ${fx.carriers.gls} WHERE id = ${o.id}`);
    const push = await mocked('pushFulfillments', [[o.id]], [{ url: 'https://api.unas.eu/shop/setOrder', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Orders><Order><Action>modify</Action><Key>1000-1000000</Key><Status>ok</Status></Order></Orders>' }]);
    assert.equal(push.result.fulfilled, 1);
    assert.match(push.requests[0].body, /<Key>1000-1000000<\/Key><Status>Feladva<\/Status><StatusEmail>no<\/StatusEmail><Shipping><PackageNumber>00123456789<\/PackageNumber><TrackingUrl>https:\/\/gls-group\.com/);

    // Stock sync: every active product once, then only what changed.
    await srv.sql(`UPDATE webshop_connections SET settings = '${JSON.stringify({ import_statuses: 'Beérkezett', stock_sync: true })}' WHERE id = 3`);
    const stockOk = (skus) => ({ url: 'https://api.unas.eu/shop/setStock', headers: XML, body: `<?xml version="1.0" encoding="UTF-8" ?>\n<Products>${skus.map((s) => `<Product><Sku>${s}</Sku><Action>modify</Action><Status>${s === 'KB-9999' ? 'error' : 'ok'}</Status>${s === 'KB-9999' ? '<Error>Nincs ilyen termék</Error>' : ''}</Product>`).join('')}</Products>` });
    const s1 = await mocked('syncConnection', [3], [ORDERS, stockOk(['KB-1001', 'KB-1002', 'KB-1003', 'KB-9999', '997000004', '99400000'])]);
    const sent = s1.requests.find((x) => x.url.endsWith('/setStock'));
    const avail = ok(await srv.call('stock.availability', [[fx.products.tap]]))[fx.products.tap].available;
    assert.match(sent.body, new RegExp(`<Sku>KB-1001</Sku><Stocks><Stock><Qty>${avail}</Qty>`));
    assert.match(sent.body, /<Sku>KB-1002<\/Sku><Stocks><Stock><Qty>\d+<\/Qty>/);
    assert.deepEqual(s1.result.stock, { updated: 5, missing: 1, failed: 0, waiting: 0 });
    const s2 = await mocked('syncConnection', [3], [ORDERS]);
    assert.ok(!s2.requests.some((x) => x.url.endsWith('/setStock')), 'nothing changed, nothing sent');
    ok(await srv.call('stock.addStock', [{ productId: fx.products.alom, locationId: 20, qty: 5, type: 'inbound' }], { as: 1 }));
    const s3 = await mocked('syncConnection', [3], [ORDERS, stockOk(['KB-1002'])]);
    const changed = s3.requests.find((x) => x.url.endsWith('/setStock'));
    assert.equal((changed.body.match(/<Product>/g) || []).length, 1);
    assert.match(changed.body, /<Sku>KB-1002<\/Sku>/);

    // A refused key: one login attempt, then nothing for 15 minutes even when asked by hand.
    await connection({ id: 4, partner: fx.clients.kutya, platform: 'unas', shopUrl: '', credentials: { api_key: 'unas-wrong' } });
    const bad = await mocked('syncConnection', [4], [{ url: 'https://api.unas.eu/shop/login', headers: XML, body: '<?xml version="1.0" encoding="UTF-8" ?>\n<Error>Hibás API kulcs</Error>' }]);
    assert.match(bad.result.errors[0], /UNAS bejelentkezés sikertelen/);
    assert.equal(bad.requests.length, 1);
    const manual = await mocked('syncConnection', [4], []);
    assert.equal(manual.requests.length, 0);
    assert.match(manual.result.errors[0], /15 percig nem próbálkozunk/);
    const test = await mocked('testConnection', [4], []);
    assert.equal(test.result.ok, false);
    assert.equal(test.requests.length, 0);
  });
});
