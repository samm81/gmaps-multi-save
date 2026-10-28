import assert from "node:assert/strict";
import test from "node:test";
import { addressesMatch, searchAttemptsForRow } from "./gmaps-place.mjs";
import { clearlyNearestCandidate, isStreetAddressPlace } from "./gmaps-save-list-ui.mjs";
import {
  michelinMapCoordinatesFromUrl,
  michelinMapQueryFromUrl,
} from "./michelin-page.mjs";

test("Michelin map queries can be local-language addresses or coordinates", () => {
  const addressUrl =
    "https://www.google.com/maps/embed/v1/place?q=%E6%96%B0%E5%BA%97%E5%8D%80%E5%85%89%E6%98%8E%E8%A1%97169%E8%99%9F%2C+New+Taipei";
  assert.equal(
    michelinMapQueryFromUrl(addressUrl),
    "新店區光明街169號, New Taipei"
  );
  assert.equal(michelinMapCoordinatesFromUrl(addressUrl), null);

  const coordinateUrl =
    "https://www.google.com/maps/embed/v1/place?q=35.0018230%2C135.7815460";
  assert.deepEqual(michelinMapCoordinatesFromUrl(coordinateUrl), {
    latitude: 35.001823,
    longitude: 135.781546,
  });
});

test("Michelin rows get a tightly bounded address search after name searches", () => {
  const row = {
    name: "Bei Ya Duck Thick Soup",
    url: "https://www.google.com/maps/search/Bei%20Ya%20Duck%20Thick%20Soup/@24.962658,121.539642",
    michelinUrl: "https://guide.michelin.com/restaurant/bei-ya-duck-thick-soup",
    address: "169 Guangming Street, Xindian District, New Taipei, Taiwan",
    latitude: "24.962658",
    longitude: "121.539642",
  };
  const attempts = searchAttemptsForRow(row);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2].maxDistanceM, 100);
  assert.match(
    decodeURIComponent(attempts[2].url),
    /restaurant 169 Guangming Street/
  );
  assert.equal(searchAttemptsForRow({ ...row, michelinUrl: "" }).length, 2);
  assert.equal(
    searchAttemptsForRow({
      ...row,
      url: "https://www.google.com/maps/place/Somewhere/data=!4m2!3m1!1s0x1:0x2",
    }).length,
    1
  );
});

test("cross-language place verification uses the street address", () => {
  assert.equal(
    addressesMatch(
      "169 Guangming Street, Xindian District, New Taipei, Taiwan",
      "No. 169號, Guangming St, Wenming Village, Xindian District, New Taipei City, Taiwan 231"
    ),
    true
  );
  assert.equal(
    addressesMatch(
      "12 Jianye Road, Shilin District, Taipei, Taiwan",
      "No. 10號, Jianye Rd, Yangming Village, Shilin District, Taipei City, Taiwan 111"
    ),
    false
  );
});

test("a direct address pin is not a restaurant, even with a place ID", () => {
  const address = "12 Jianye Road, Shilin District, Taipei, Taiwan";
  assert.equal(
    isStreetAddressPlace(
      "No. 12, Jianye Rd, Yangming Village, Shilin District",
      address
    ),
    true
  );
  assert.equal(isStreetAddressPlace("YMS onefifteen 初衣食午", address), false);
});

test("a local-language match needs a clearly nearest result", () => {
  const restaurant = { distanceM: 4 };
  assert.equal(
    clearlyNearestCandidate([{ distanceM: 37 }, restaurant]),
    restaurant
  );
  assert.equal(
    clearlyNearestCandidate([{ distanceM: 37 }, { distanceM: 15 }]).distanceM,
    15
  );
  assert.equal(
    clearlyNearestCandidate([{ distanceM: 25 }, { distanceM: 8 }]).distanceM,
    8
  );
  assert.equal(
    clearlyNearestCandidate([{ distanceM: 5 }, { distanceM: 12 }]),
    null
  );
  assert.equal(
    clearlyNearestCandidate([{ distanceM: null }, restaurant]),
    null
  );
});
