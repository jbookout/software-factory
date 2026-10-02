# Ownership Illustration

The bundled `assets/site/finance.js` implements arithmetic, not lending policy or investment advice. Every input comes from the current client scenario. The example uses a 30% owner allocation, 100% purchase financing, estimated 6.25% interest, 25-year amortization, a 10-year hold, 1.5% appreciation, $28/SF/year base rent, 5% collection allowance, and a 24-month linear tenant fill. None is a verified offer or forecast.

## Contract

`PresentationFinance.compute(property, assumptions, tiRate)` returns numeric totals and annual chart points. Property requires `price` and integer `totalSf`. Assumptions require `occupancyFraction`, `downPaymentFraction`, `annualInterest`, `amortizationYears`, `holdYears`, `annualAppreciation`, `annualRentPerSf`, `collectionLoss`, `fillMonths`, and `practiceBuildoutPerSf`. Fractions are decimals, rates are annual, dollars are unrounded, and SF is rounded up only once for the practice allocation.

## Formulas

Let P be purchase price, d down-payment fraction, S total SF, f practice fraction, r monthly interest, N amortization months, H hold months.

- Practice SF = ceil(S × f); tenant SF = S − practice SF. Use these same areas for all rents and TI.
- Loan L = P × (1 − d); down payment = P × d.
- Monthly principal and interest M = L × r / (1 − (1+r)^−N). At zero interest, M = L/N.
- Balance after m payments follows the amortization schedule; stop debt service at maturity. No interest-only period or balloon is assumed.
- Value at year y = P × (1 + annual appreciation)^y.
- Appreciation = value − P; principal repaid = L − balance; equity = value − balance. Equity includes the initial down payment.
- Stabilized outside monthly rent = tenant SF × annual base rent / 12 × (1 − collection allowance).
- Collection in month k = stabilized rent × min(1, (k − 0.5)/fillMonths). Zero fill months means full collection from month one. A 24-month ramp averages 25% in year one and 75% in year two.
- Mortgage payments you fund = cumulative principal/interest payments − collected outside tenant rent. Negative means outside rent exceeds modeled debt service; label it as a surplus.
- Practice base rent avoided = practice SF × annual base rent × hold years. This assumes the same rent basis for the leasing alternative.
- Practice buildout = practice SF × buildout cost/SF. Tenant TI = tenant SF × selected TI/SF. Combined budget = practice buildout + tenant TI; this is separate from the purchase price/down payment.
- Extra cash versus leasing = down payment + mortgage payments you fund + tenant TI − practice rent avoided.
- Estimated financial benefit of owning versus leasing = year-end equity − extra cash versus leasing.

Including down payment in extra cash prevents counting initial invested equity as a return. The assumed practice buildout cancels only if identical in owning and leasing. Include any difference, landlord practice TI under leasing, financing of improvements, unreimbursed owner expenses, or other cash items before claiming a complete comparison.

## Client-facing labels

**Mortgage Payments You Fund Over 10 Years**

Total mortgage payments minus rent collected from outside tenants.

**Estimated 10-Year Financial Benefit of Owning vs. Leasing**

Equity + practice rent avoided − mortgage payments you fund − tenant TI − down payment.

This is a provisional, undiscounted illustration. It excludes closing/selling costs, taxes, commissions, reserves, repairs, capital expenditures, unreimbursed ownership expenses and opportunity cost unless explicitly added. Equity is not liquid cash or sale proceeds. NNN base rent does not prove all owner expenses are reimbursed. A plotted equity/carry crossing is a comparison of two modeled quantities, not investment break-even. Cap rates require verified NOI; do not call gross/imputed rent a verified cap rate.

Round only displayed dollars; retain precision in intermediate calculations. Recompute at least one property independently by a month-by-month loan schedule and rent sum. Check each TI option changes combined budget and financial benefit by exactly tenant SF times the TI-rate difference.
