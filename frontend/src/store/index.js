import { configureStore } from '@reduxjs/toolkit';
import customerReducer from './customerSlice';
import companyReducer from './companySlice';
import sheetReducer from './sheetSlice';

export const store = configureStore({
  reducer: {
    customer: customerReducer,
    company: companyReducer,
    sheets: sheetReducer,
  },
});

export default store;
