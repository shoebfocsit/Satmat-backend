import { parseVipHomepage, parseVipLucky, parseMarketSchedule } from './vip-live.parser';

describe('parseVipHomepage', () => {
  it('parses markup A (.S1 > .yom + .D1)', () => {
    const html = `
      <div class="S1" style="background-color:yellow;">
        <div class="yom" style="color:blue;">MILAN DAY</div>
        <span class="D1">139-3</span><br/>
      </div>
      <div class="S1"><div class="yom">SRIDEVI</div><span class="D1">269-70-235</span></div>
      <div class="S1"><div class="yom">KALYAN</div><span class="D1">Loading...</span></div>`;
    const rows = parseVipHomepage(html);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ marketId: 'milan-day', open: '139', jodi: null, close: null });
    expect(rows).toContainEqual({ marketId: 'sridevi', open: '269', jodi: '70', close: '235' });
  });

  it('parses markup B (div.fix > green/black spans)', () => {
    const html = `
      <div class="fix"><span style="color:green;">RAJDHANI DAY</span><span style="color:black;">799-5</span>
        <div><div class="jodichartleft"><a>Jodi</a></div></div>
      </div>
      <div class="fix"><span>MADHUR NIGHT</span><span>358-66-367</span></div>
      <div class="fix"><span>MOHINI DAY</span><span>HOLIDAY</span></div>`;
    const rows = parseVipHomepage(html);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ marketId: 'rajdhani-day', open: '799', jodi: null, close: null });
    expect(rows).toContainEqual({ marketId: 'madhur-night', open: '358', jodi: '66', close: '367' });
  });

  it('maps exact names only and skips unknown/holiday/loading', () => {
    const html = `
      <div class="fix"><span>SRIDEVI BAZAR</span><span>560-12-480</span></div>
      <div class="fix"><span>MAIN KALYAN</span><span>136-03-247</span></div>
      <div class="fix"><span>TIME BAZAR</span><span>259-67-133</span></div>
      <div class="fix"><span>KALYAN NIGHT</span><span>***-**-***</span></div>`;
    const rows = parseVipHomepage(html);
    // SRIDEVI BAZAR / MAIN KALYAN are different markets — must NOT map.
    expect(rows).toEqual([
      { marketId: 'time-bazar-day', open: '259', jodi: '67', close: '133' },
    ]);
  });

  it('parses open+jodi partial (close pending)', () => {
    const html = `<div class="fix"><span>SUPREME DAY</span><span>200-25</span></div>`;
    expect(parseVipHomepage(html)).toEqual([
      { marketId: 'supreme-day', open: '200', jodi: '25', close: null },
    ]);
  });
});

describe('parseVipLucky', () => {
  const html = `
    <div class="menu3">
      <div class="live-result1">Today Satta Matka Lucky Number&nbsp;</div>
      <table class="table">
        <tr><td><span style="color:red">Ank (शुभांक)</span></td><td><span style="color:red">Final Ank</span></td></tr>
        <tr><td>2-6-5-8</td><td>K-4, M-4</td></tr>
      </table>
    </div>`;

  it('parses Ank + Final Ank from the lucky block', () => {
    expect(parseVipLucky(html)).toEqual({ ank: '2-6-5-8', finalAnk: 'K-4, M-4' });
  });

  it('returns null when the block is absent', () => {
    expect(parseVipLucky('<div><p>no lucky here</p></div>')).toBeNull();
  });

  it('returns null when values are empty', () => {
    const empty = html.replace('2-6-5-8', '').replace('K-4, M-4', '');
    expect(parseVipLucky(empty)).toBeNull();
  });
});

describe('parseMarketSchedule', () => {
  const html = `
    <table>
      <tr><th>Market Name</th><th>Open Time</th><th>Close Time</th><th>Status</th></tr>
      <tr><td>Milan Day</td><td>3:00 PM</td><td>5:00 PM</td><td>Mon-Sat</td></tr>
      <tr><td>RAJDHANI DAY</td><td>03:15 PM</td><td>05:15 PM</td><td>Mon-Sat</td></tr>
      <tr><td>Kalyan</td><td>3:45 PM</td><td>5:45 PM</td><td>Mon-Sat</td></tr>
      <tr><td>Sridevi</td><td>11:30 AM</td><td>12:30 PM</td><td>Daily</td></tr>
      <tr><td>Malamal Bombay</td><td>11:400 AM</td><td>12:40 PM</td><td>Daily</td></tr>
      <tr><td>Day Bombay</td><td>12:00 PM</td><td>2:00 PM</td><td>Daily</td></tr>
      <tr><td>Main Bazar</td><td>9:35 PM</td><td>12:05 AM</td><td>Mon-Fri</td></tr>
    </table>`;

  it('extracts site-exact timings for known markets only', () => {
    expect(parseMarketSchedule(html)).toEqual([
      { marketId: 'milan-day', openTime: '3:00 PM', closeTime: '5:00 PM' },
      { marketId: 'rajdhani-day', openTime: '03:15 PM', closeTime: '05:15 PM' },
      { marketId: 'kalyan', openTime: '3:45 PM', closeTime: '5:45 PM' },
      { marketId: 'sridevi', openTime: '11:30 AM', closeTime: '12:30 PM' },
      { marketId: 'main-bazar', openTime: '9:35 PM', closeTime: '12:05 AM' },
    ]);
    // Malamal Bombay (site's own "11:400 AM" typo) and Day Bombay
    // (not our market) are skipped, never stored.
  });

  it('ignores tables without schedule headers', () => {
    expect(
      parseMarketSchedule('<table><tr><td>Milan Day</td><td>3:00 PM</td></tr></table>'),
    ).toEqual([]);
    expect(parseMarketSchedule('<div>no tables</div>')).toEqual([]);
  });
});
