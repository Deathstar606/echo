import { configureStore } from '@reduxjs/toolkit';
import customerReducer from './customerSlice';
import companyReducer from './companySlice';

export const store = configureStore({
  reducer: {
    customer: customerReducer,
    company: companyReducer,
  },
});

export default store;
