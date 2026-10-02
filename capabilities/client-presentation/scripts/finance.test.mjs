import assert from 'node:assert/strict';
import test from 'node:test';
import '../assets/site/finance.js';
const {compute} = globalThis.PresentationFinance;
const a = {occupancyFraction:.3,downPaymentFraction:0,annualInterest:.0625,
  amortizationYears:25,holdYears:10,annualAppreciation:.015,
  annualRentPerSf:28,collectionLoss:.05,fillMonths:24,practiceBuildoutPerSf:170};
function close(x,y,tolerance=.00001){assert.ok(Math.abs(x-y)<tolerance,`${x} != ${y}`);}
test('cash-flow sums reconcile with independent closed-form balance and two-year rent ramp',()=>{
  const p={price:2400000,totalSf:10001}; const m=compute(p,a,25);
  assert.equal(m.practiceSf,3001);assert.equal(m.tenantSf,7000);
  const r=.0625/12, q=(1+r)**120;
  close(m.balance,2400000*q-m.payment*(q-1)/r);
  const annual=7000*28*.95;
  close(m.outsideRent,annual*9); // year1 .25 + year2 .75 + eight full years
  close(m.equity,m.value-m.balance);
  close(m.benefit,m.equity+3001*28*10-m.carry-7000*25);
  assert.equal(m.years.length,11);
});
test('TI has one source of truth for budget and benefit',()=>{
  const p={price:2000000,totalSf:12000};const lo=compute(p,a,25),hi=compute(p,a,75);
  close(hi.combinedBudget-lo.combinedBudget,8400*50);
  close(lo.benefit-hi.benefit,8400*50);
  close(lo.carry,hi.carry);
});
test('nonzero down payment is not counted as earned return',()=>{
  const m=compute({price:1000000,totalSf:10000},{...a,downPaymentFraction:.2,annualAppreciation:0,annualRentPerSf:0},0);
  close(m.loan,800000);close(m.equity,200000+m.principalRepaid);
  close(m.benefit,m.principalRepaid-m.mortgagePayments);
});
test('zero interest, immediate fill, declining value and hold beyond maturity',()=>{
  const m=compute({price:100000,totalSf:101},{...a,annualInterest:0,amortizationYears:5,
    holdYears:10,annualAppreciation:-.01,fillMonths:0},25);
  assert.equal(m.practiceSf,31);assert.equal(m.tenantSf,70);assert.equal(m.balance,0);
  close(m.mortgagePayments,100000);close(m.outsideRent,70*28*.95*10);
  close(m.value,100000*.99**10);
  const cash=compute({price:100000,totalSf:101},{...a,downPaymentFraction:1},0);
  assert.equal(cash.payment,0);assert.equal(cash.balance,0);
});
test('invalid inputs fail rather than display plausible zeroes',()=>{
  for(const bad of [NaN,-1,'2400000'])assert.throws(()=>compute({price:bad,totalSf:10000},a,25));
  assert.throws(()=>compute({price:100,totalSf:10.5},a,25));
  assert.throws(()=>compute({price:100,totalSf:10},{...a,occupancyFraction:1.1},25));
  assert.throws(()=>compute({price:100,totalSf:10},{...a,annualInterest:undefined},25));
});
