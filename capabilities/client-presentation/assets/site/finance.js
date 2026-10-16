/* Portable scenario arithmetic. No lending-policy or eligibility claims. */
(function (root) {
  'use strict';
  function finite(name, value, min, max = Infinity) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`${name} must be a finite number from ${min} to ${max}`);
    }
    return value;
  }
  function compute(property, a, tiRate) {
    const price = finite('price', property.price, 0);
    const sf = finite('totalSf', property.totalSf, 1);
    if (!Number.isInteger(sf)) throw new RangeError('totalSf must be an integer');
    finite('occupancyFraction', a.occupancyFraction, 0, 1);
    finite('downPaymentFraction', a.downPaymentFraction, 0, 1);
    finite('annualInterest', a.annualInterest, 0, 1);
    finite('amortizationYears', a.amortizationYears, 1 / 12, 100);
    finite('holdYears', a.holdYears, 1, 100);
    if (!Number.isInteger(a.holdYears) || !Number.isInteger(a.amortizationYears * 12)) {
      throw new RangeError('holdYears must be whole years; amortization must be whole months');
    }
    finite('annualAppreciation', a.annualAppreciation, -1, 1);
    finite('annualRentPerSf', a.annualRentPerSf, 0);
    finite('collectionLoss', a.collectionLoss, 0, 1);
    finite('fillMonths', a.fillMonths, 0, 1200);
    finite('practiceBuildoutPerSf', a.practiceBuildoutPerSf, 0);
    finite('tiRate', tiRate, 0);
    const practiceSf = Math.ceil(sf * a.occupancyFraction), tenantSf = sf - practiceSf;
    const downPayment = price * a.downPaymentFraction, loan = price - downPayment;
    const n = a.amortizationYears * 12, r = a.annualInterest / 12;
    const payment = loan === 0 ? 0 : r === 0 ? loan / n : loan * r / (1 - Math.pow(1 + r, -n));
    const rent = tenantSf * a.annualRentPerSf / 12 * (1 - a.collectionLoss);
    const tenantTi = tenantSf * tiRate, practiceBuildout = practiceSf * a.practiceBuildoutPerSf;
    let balance = loan, mortgagePayments = 0, outsideRent = 0;
    function point(year) {
      const value = price * Math.pow(1 + a.annualAppreciation, year);
      const equity = value - balance, carry = mortgagePayments - outsideRent;
      const avoidedPracticeRent = practiceSf * a.annualRentPerSf * year;
      const extraCashRequired = downPayment + carry + tenantTi - avoidedPracticeRent;
      return {year, practiceSf, tenantSf, loan, downPayment, payment, stabilizedMonthlyRent:rent, balance, value,
        appreciation: value - price, principalRepaid: loan - balance, equity,
        outsideRent, mortgagePayments, carry, avoidedPracticeRent, tenantTi,
        practiceBuildout, combinedBudget: practiceBuildout + tenantTi,
        extraCashRequired, benefit: equity - extraCashRequired};
    }
    const years = [point(0)];
    for (let month = 1; month <= a.holdYears * 12; month++) {
      if (month <= n && balance > 0) {
        const paid = Math.min(payment, balance * (1 + r));
        mortgagePayments += paid;
        balance = month === n ? 0 : Math.max(0, balance * (1 + r) - paid);
      }
      const fill = a.fillMonths === 0 ? 1 : Math.min(1, (month - 0.5) / a.fillMonths);
      outsideRent += rent * fill;
      if (month % 12 === 0) years.push(point(month / 12));
    }
    return {...years[years.length - 1], years};
  }
  root.PresentationFinance = Object.freeze({compute});
})(typeof window === 'undefined' ? globalThis : window);
