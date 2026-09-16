import { parsePanelChart } from './satmat-web.parser';

describe('parsePanelChart', () => {
  it('parses days as [open panna | jodi | close panna] from a week row', () => {
    const html = `
      <table>
        <tr><td>Date</td><td>Mon</td><td>Tue</td><td>Wed</td><td>Thu</td><td>Fri</td><td>Sat</td><td>Sun</td></tr>
        <tr>
          <td class="week-label">10/08/2026 to 14/08/2026</td>
          <td class="r">116</td><td class="r">83</td><td class="r">346</td>
          <td>266</td><td>47</td><td>700</td>
          <td>350</td><td>85</td><td>366</td>
          <td>499</td><td>27</td><td>124</td>
          <td>114</td><td>60</td><td>460</td>
          <td></td><td></td><td></td>
          <td>***</td><td>**</td><td>***</td>
        </tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      date: '2026-08-10',
      open: '116',
      jodi: '83',
      close: '346',
    });
    expect(rows[4]).toEqual({
      date: '2026-08-14',
      open: '114',
      jodi: '60',
      close: '460',
    });
  });

  it('normalizes cells whose digits are stacked with <br>', () => {
    const html = `
      <table>
        <tr>
          <td>03/08/2026 to 09/08/2026</td>
          <td class="r">1<br>7<br>7</td><td class="r">5<br>8</td><td class="r">2<br>6<br>0</td>
        </tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: '2026-08-03',
      open: '177',
      jodi: '58',
      close: '260',
    });
  });

  it('emits partial days (open declared, close pending) with nulls', () => {
    const html = `
      <table>
        <tr>
          <td>10/08/2026 to 14/08/2026</td>
          <td class="r">116</td><td class="r">83</td><td class="r">346</td>
          <td>129</td><td></td><td></td>
          <td></td><td></td><td></td>
        </tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-08-10', open: '116', jodi: '83', close: '346' });
    // open-only day: lively OPEN, close pending
    expect(rows[1]).toEqual({ date: '2026-08-11', open: '129', jodi: null, close: null });
  });

  it('parses mixed th/td cells (sattamatkavip.in format)', () => {
    const html = `
      <table class="pchart">
        <tr><th>Date</th><th colspan="3">MON</th><th colspan="3">TUE</th><th colspan="3">WED</th><th colspan="3">THU</th><th colspan="3">FRI</th><th colspan="3">SAT</th><th colspan="3">SUN</th></tr>
        <tr><th>30/10/17<br/>to<br/>05/11/17</th><th>1<br/>6<br/>6</th><td>39</td><th>5<br/>5<br/>9</th><th>1<br/>7<br/>8</th><td>62</td><th>5<br/>8<br/>9</th><th>*<br/>*<br/>*</th><td><span style="color: #ff0000;">**</span></td><th>*<br/>*<br/>*</th></tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2017-10-30', open: '166', jodi: '39', close: '559' });
    expect(rows[1]).toEqual({ date: '2017-10-31', open: '178', jodi: '62', close: '589' });
  });

  it('rejects a non-date label (header/footer rows)', () => {
    const html = `<table><tr><td>Date</td><td>Mon</td></tr></table>`;
    expect(parsePanelChart(html)).toHaveLength(0);
  });

  it('returns nothing when there is no table', () => {
    expect(parsePanelChart('<div>no table</div>')).toHaveLength(0);
  });

  it('parses 2-digit-year week labels (sattamatkakgf.com format)', () => {
    const html = `
      <table>
        <tr>
          <td>31/07/17 to 05/08/17</td>
          <td>2<br>3<br>5</td><td>06</td><td>1<br>2<br>3</td>
          <td>1<br>3<br>5</td><td>90</td><td>3<br>7<br>0</td>
          <td>4<br>7<br>8</td><td>96</td><td>1<br>5<br>0</td>
        </tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      date: '2017-07-31',
      open: '235',
      jodi: '06',
      close: '123',
    });
    expect(rows[1]).toEqual({
      date: '2017-08-01',
      open: '135',
      jodi: '90',
      close: '370',
    });
    expect(rows[2]).toEqual({
      date: '2017-08-02',
      open: '478',
      jodi: '96',
      close: '150',
    });
  });

  it('maps 2-digit year 26 to 2026 (current-era provider data)', () => {
    const html = `
      <table>
        <tr>
          <td>24/08/26 to 30/08/26</td>
          <td>1<br>1<br>6</td><td>83</td><td>3<br>4<br>6</td>
        </tr>
      </table>`;

    const rows = parsePanelChart(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: '2026-08-24',
      open: '116',
      jodi: '83',
      close: '346',
    });
  });
});
