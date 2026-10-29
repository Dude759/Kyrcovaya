import './setup';
import {it,afterEach,beforeEach,vi,expect} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {OperatorManagementPage} from '../src/pages/OperatorManagementPage';
import {Context,type AppState} from '../src/state/context';
import {api} from '../src/services/api';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
beforeEach(()=>{Object.defineProperties(HTMLDialogElement.prototype,{showModal:{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}},close:{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}}});vi.spyOn(api,'operatorStations').mockResolvedValue({items:[]});vi.spyOn(api,'operatorEvents').mockResolvedValue({items:[],nextCursor:null});});
function show(){render(<MemoryRouter><Context.Provider value={{refresh:vi.fn(async()=>{})} as unknown as AppState}><OperatorManagementPage/></Context.Provider></MemoryRouter>);}
it('creates teaching station with stable key and longitude-first coordinates',async()=>{const save=vi.spyOn(api,'operatorSave').mockResolvedValue({id:'new'});vi.spyOn(api,'operatorPorts').mockResolvedValue({items:[]});show();fireEvent.click(screen.getByRole('button',{name:'Создать станцию'}));fireEvent.change(screen.getByLabelText('Адрес'),{target:{value:'Учебный адрес'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить'}));await waitFor(()=>expect(save).toHaveBeenCalled());expect(save.mock.calls[0][0]).toBe('stations');expect(save.mock.calls[0][1]).toMatchObject({coordinates:[37.62,55.75]});expect(save.mock.calls[0][3]).toBeTruthy();expect(screen.getByText(/нет данных без подтверждённых измерений/)).toBeTruthy();});
it('server conflict keeps form and preserves idempotency key on retry',async()=>{const save=vi.spyOn(api,'operatorSave').mockRejectedValue(new Error('конфликт'));show();fireEvent.click(screen.getByRole('button',{name:'Создать станцию'}));fireEvent.change(screen.getByLabelText('Адрес'),{target:{value:'Учебный адрес'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить'}));await screen.findByText('конфликт');fireEvent.click(screen.getByRole('button',{name:'Сохранить'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[0][3]).toBe(save.mock.calls[1][3]);});
