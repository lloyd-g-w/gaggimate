import { faTrashCan } from '@fortawesome/free-solid-svg-icons/faTrashCan';
import { faEye } from '@fortawesome/free-solid-svg-icons/faEye';
import { faEyeSlash } from '@fortawesome/free-solid-svg-icons/faEyeSlash';
import { faPaperPlane } from '@fortawesome/free-solid-svg-icons/faPaperPlane';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import homekitImage from '../../assets/homekit.png';
import { faCalendarDays } from '@fortawesome/free-solid-svg-icons/faCalendarDays';
import { computed } from '@preact/signals';
import { useCallback, useState } from 'preact/hooks';
import { machine } from '../../services/ApiService.js';

const gearpumpAddon = computed(() => machine.value.capabilities.gearpumpAddon);

const DISCORD_FIELD_OPTIONS = [
  { bit: 0x01, label: 'Profile' },
  { bit: 0x02, label: 'Duration' },
  { bit: 0x04, label: 'Yield' },
  { bit: 0x08, label: 'Temperature' },
  { bit: 0x10, label: 'Pressure' },
  { bit: 0x20, label: 'Flow' },
];

export function parseDiscordUsers(str) {
  if (!str) return [];
  return str
    .split(';')
    .filter(entry => entry.length > 0)
    .map(entry => {
      const [id, flag] = entry.split(':');
      return { id: id ?? '', enabled: flag === '1' };
    });
}

export function serializeDiscordUsers(list) {
  return list.map(user => `${user.id ?? ''}:${user.enabled ? '1' : '0'}`).join(';');
}

export function PluginCard({
  formData,
  onChange,
  autowakeupSchedules,
  addAutoWakeupSchedule,
  removeAutoWakeupSchedule,
  updateAutoWakeupTime,
  updateAutoWakeupDay,
}) {
  const [showDiscordToken, setShowDiscordToken] = useState(false);
  const [showDiscordAiKey, setShowDiscordAiKey] = useState(false);
  const [showGaggibotToken, setShowGaggibotToken] = useState(false);
  // 0 idle, 1 running, 2 ok, 3 failed — mirrors the plugin's test state machine.
  const [discordTest, setDiscordTest] = useState({ state: 0, message: '' });
  const [discordTestPending, setDiscordTestPending] = useState(false);

  const runDiscordTest = useCallback(async () => {
    setDiscordTestPending(true);
    setDiscordTest({ state: 1, message: 'Contacting the bridge…' });
    try {
      await fetch('/api/plugins/discord/test', { method: 'POST' });
      // The display performs the test on its own task, so poll until it reports a result.
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await fetch('/api/plugins/discord/test');
        if (!response.ok) continue;
        const result = await response.json();
        setDiscordTest({ state: result.state ?? 0, message: result.message ?? '' });
        if (result.state === 2 || result.state === 3) break;
      }
    } catch (e) {
      setDiscordTest({ state: 3, message: 'Could not reach the display' });
    } finally {
      setDiscordTestPending(false);
    }
  }, []);

  const discordUsers = parseDiscordUsers(formData.discordUsers);
  const discordFieldsValue =
    formData.discordFields !== undefined ? Number(formData.discordFields) : 0x3f;

  const updateDiscordUser = (index, patch) => {
    const users = parseDiscordUsers(formData.discordUsers);
    users[index] = { ...users[index], ...patch };
    onChange('discordUsers')({ currentTarget: { value: serializeDiscordUsers(users) } });
  };

  const addDiscordUser = () => {
    const users = parseDiscordUsers(formData.discordUsers);
    users.push({ id: '', enabled: true });
    onChange('discordUsers')({ currentTarget: { value: serializeDiscordUsers(users) } });
  };

  const removeDiscordUser = index => {
    const users = parseDiscordUsers(formData.discordUsers);
    users.splice(index, 1);
    onChange('discordUsers')({ currentTarget: { value: serializeDiscordUsers(users) } });
  };

  const toggleDiscordField = bit => {
    const next = discordFieldsValue ^ bit;
    onChange('discordFields')({ currentTarget: { value: String(next) } });
  };

  return (
    <div className='space-y-4'>
      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>Automatic Wakeup Schedule</span>
          <input
            id='autowakeupEnabled'
            name='autowakeupEnabled'
            value='autowakeupEnabled'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.autowakeupEnabled}
            onChange={onChange('autowakeupEnabled')}
            aria-label='Enable Auto Wakeup'
          />
        </div>
        {formData.autowakeupEnabled && (
          <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
            <p className='text-sm opacity-70'>
              Automatically switch to brew mode at specified time(s) of day.
            </p>
            <div className='form-control'>
              <label className='mb-2 block text-sm font-medium'>Auto Wakeup Schedule</label>
              <div className='space-y-2'>
                {autowakeupSchedules?.map((schedule, scheduleIndex) => (
                  <div
                    key={scheduleIndex}
                    className='flex flex-wrap items-center gap-1 md:flex-nowrap'
                  >
                    {/* Time input */}
                    <div className='grow-1 text-center sm:text-start'>
                      <input
                        type='time'
                        className='input input-bordered input-sm md:input-md w-auto min-w-0 pr-6 text-center'
                        value={schedule.time}
                        onChange={e => updateAutoWakeupTime(scheduleIndex, e.target.value)}
                        disabled={!formData.autowakeupEnabled}
                      />
                    </div>

                    {/* Days toggle buttons */}
                    <div
                      className='join flex grow-8'
                      role='group'
                      aria-label='Days of week selection'
                    >
                      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((dayLabel, dayIndex) => (
                        <button
                          key={dayIndex}
                          type='button'
                          className={`join-item btn btn-sm md:btn-md flex-grow ${schedule.days[dayIndex] ? 'btn-primary' : 'btn-neutral text-neutral-content/20'}`}
                          onClick={() =>
                            updateAutoWakeupDay(scheduleIndex, dayIndex, !schedule.days[dayIndex])
                          }
                          disabled={!formData.autowakeupEnabled}
                          aria-pressed={schedule.days[dayIndex]}
                          aria-label={
                            [
                              'Monday',
                              'Tuesday',
                              'Wednesday',
                              'Thursday',
                              'Friday',
                              'Saturday',
                              'Sunday',
                            ][dayIndex]
                          }
                          title={
                            [
                              'Monday',
                              'Tuesday',
                              'Wednesday',
                              'Thursday',
                              'Friday',
                              'Saturday',
                              'Sunday',
                            ][dayIndex]
                          }
                        >
                          {dayLabel}
                        </button>
                      ))}
                    </div>
                    {/* Delete button */}
                    {autowakeupSchedules.length > 1 ? (
                      <button
                        type='button'
                        onClick={() => removeAutoWakeupSchedule(scheduleIndex)}
                        className='btn btn-ghost btn-sm md:btn-md grow-1'
                        disabled={!formData.autowakeupEnabled}
                        title='Delete this schedule'
                      >
                        <FontAwesomeIcon icon={faTrashCan} className='text-base' />
                      </button>
                    ) : (
                      <div
                        className='btn btn-ghost btn-sm md:btn-md grow-1 cursor-not-allowed opacity-30'
                        title='Cannot delete the last schedule'
                      >
                        <FontAwesomeIcon icon={faTrashCan} className='text-base' />
                      </div>
                    )}
                  </div>
                ))}
                <button
                  type='button'
                  onClick={addAutoWakeupSchedule}
                  className='btn btn-primary btn-sm md:btn-md mt-2'
                  disabled={!formData.autowakeupEnabled}
                  aria-label='Add schedule'
                  title='Add schedule'
                >
                  <FontAwesomeIcon icon={faCalendarDays} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>HomeKit</span>
          <input
            id='homekit'
            name='homekit'
            value='homekit'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.homekit}
            onChange={onChange('homekit')}
            aria-label='Enable HomeKit'
          />
        </div>
        {formData.homekit && (
          <div className='border-base-300 mt-4 flex flex-col items-center justify-center gap-4 border-t pt-4'>
            <img src={homekitImage} alt='HomeKit Setup Code' />
            <p className='text-center'>
              Open the Home app on your iOS device, select Add Accessory, and enter the setup code
              shown above.
            </p>
          </div>
        )}
      </div>

      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>Boiler Refill Plugin</span>
          <input
            id='boilerFillActive'
            name='boilerFillActive'
            value='boilerFillActive'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.boilerFillActive}
            onChange={onChange('boilerFillActive')}
            aria-label='Enable Boiler Refill'
          />
        </div>
        {formData.boilerFillActive && (
          <div className='border-base-300 mt-4 grid grid-cols-2 gap-4 border-t pt-4'>
            <div className='form-control'>
              <label htmlFor='startupFillTime' className='mb-2 block text-sm font-medium'>
                On startup (s)
              </label>
              <input
                id='startupFillTime'
                name='startupFillTime'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                value={formData.startupFillTime}
                onChange={onChange('startupFillTime')}
              />
            </div>
            <div className='form-control'>
              <label htmlFor='steamFillTime' className='mb-2 block text-sm font-medium'>
                On steam deactivate (s)
              </label>
              <input
                id='steamFillTime'
                name='steamFillTime'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                value={formData.steamFillTime}
                onChange={onChange('steamFillTime')}
              />
            </div>
          </div>
        )}
      </div>

      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>Smart Grind Plugin</span>
          <input
            id='smartGrindActive'
            name='smartGrindActive'
            value='smartGrindActive'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.smartGrindActive}
            onChange={onChange('smartGrindActive')}
            aria-label='Enable Smart Grind'
          />
        </div>
        {formData.smartGrindActive && (
          <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
            <p className='text-sm opacity-70'>
              This feature controls a Tasmota Plug to turn off your grinder after the target has
              been reached.
            </p>
            <div className='form-control'>
              <label htmlFor='smartGrindIp' className='mb-2 block text-sm font-medium'>
                Tasmota IP
              </label>
              <input
                id='smartGrindIp'
                name='smartGrindIp'
                type='text'
                className='input input-bordered w-full'
                placeholder='0'
                value={formData.smartGrindIp}
                onChange={onChange('smartGrindIp')}
              />
            </div>
            <div className='form-control'>
              <label htmlFor='smartGrindMode' className='mb-2 block text-sm font-medium'>
                Mode
              </label>
              <select
                id='smartGrindMode'
                name='smartGrindMode'
                className='select select-bordered w-full'
                onChange={onChange('smartGrindMode')}
              >
                <option value='0' selected={formData.smartGrindMode?.toString() === '0'}>
                  Turn off at target
                </option>
                <option value='1' selected={formData.smartGrindMode?.toString() === '1'}>
                  Toggle off and on at target
                </option>
                <option value='2' selected={formData.smartGrindMode?.toString() === '2'}>
                  Turn on at start, off at target
                </option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>Home Assistant over MQTT (Deprecated)</span>
          <input
            id='homeAssistant'
            name='homeAssistant'
            value='homeAssistant'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.homeAssistant}
            onChange={onChange('homeAssistant')}
            aria-label='Enable Home Assistant'
          />
        </div>
        {formData.homeAssistant && (
          <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
            <p className='text-sm opacity-70'>
              This feature allows connection to a Home Assistant or MQTT installation and push the
              current state. This feature is deprecated for usage with Home Assistant. Please see
              the{' '}
              <a
                href='https://github.com/gaggimate/ha-integration'
                target='_blank'
                rel='noreferrer'
              >
                Home Assistant Integration
              </a>{' '}
              for a more up-to-date solution.
            </p>
            <div className='form-control'>
              <label htmlFor='haIP' className='mb-2 block text-sm font-medium'>
                MQTT IP
              </label>
              <input
                id='haIP'
                name='haIP'
                type='text'
                className='input input-bordered w-full'
                placeholder='0'
                value={formData.haIP}
                onChange={onChange('haIP')}
              />
            </div>

            <div className='form-control'>
              <label htmlFor='haPort' className='mb-2 block text-sm font-medium'>
                MQTT Port
              </label>
              <input
                id='haPort'
                name='haPort'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                value={formData.haPort}
                onChange={onChange('haPort')}
              />
            </div>

            <div className='form-control'>
              <label htmlFor='haUser' className='mb-2 block text-sm font-medium'>
                MQTT User
              </label>
              <input
                id='haUser'
                name='haUser'
                type='text'
                className='input input-bordered w-full'
                placeholder='user'
                value={formData.haUser}
                onChange={onChange('haUser')}
              />
            </div>

            <div className='form-control'>
              <label htmlFor='haPassword' className='mb-2 block text-sm font-medium'>
                MQTT Password
              </label>
              <input
                id='haPassword'
                name='haPassword'
                type='password'
                className='input input-bordered w-full'
                placeholder='password'
                value={formData.haPassword}
                onChange={onChange('haPassword')}
              />
            </div>
            <div className='form-control'>
              <label htmlFor='haTopic' className='mb-2 block text-sm font-medium'>
                Home Assistant Discovery Topic
              </label>
              <input
                id='haTopic'
                name='haTopic'
                type='text'
                className='input input-bordered w-full'
                value={formData.haTopic}
                onChange={onChange('haTopic')}
              />
            </div>
          </div>
        )}
      </div>

      <div className='bg-base-200 rounded-lg p-4'>
        <div className='flex items-center justify-between'>
          <span className='text-xl font-medium'>Discord Shot Feedback</span>
          <input
            id='discord'
            name='discord'
            value='discord'
            type='checkbox'
            className='toggle toggle-primary'
            checked={!!formData.discord}
            onChange={onChange('discord')}
            aria-label='Enable Discord Shot Feedback'
          />
        </div>
        {formData.discord && (
          <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
            <p className='text-sm opacity-70'>
              After every saved shot, GaggiMate sends the shot to Discord and stores the feedback
              back in shot history. External Gaggibot mode is recommended: Docker handles Discord,
              reactions and optional AI without loading the display. Leave its URL empty only to
              use the legacy direct-from-display mode.
            </p>

            <div className='badge badge-primary'>
              Mode: {formData.gaggibotUrl ? 'External Gaggibot (recommended)' : 'Direct from display (legacy)'}
            </div>

            <div className='rounded-box bg-base-200 space-y-2 p-3'>
              <div className='flex flex-wrap items-center gap-2'>
                <button
                  type='button'
                  className='btn btn-sm btn-primary'
                  disabled={discordTestPending || !formData.discord}
                  onClick={runDiscordTest}
                >
                  {discordTestPending ? (
                    <span className='loading loading-spinner loading-xs' />
                  ) : (
                    <FontAwesomeIcon icon={faPaperPlane} />
                  )}
                  {discordTestPending ? 'Testing…' : 'Send test message'}
                </button>
                <span className='text-xs opacity-60'>
                  Save the settings first, then send a test to confirm the path works. Nothing is
                  recorded as a shot.
                </span>
              </div>
              {!formData.discord && (
                <p className='text-xs opacity-60'>Enable Discord shot feedback to test it.</p>
              )}
              {discordTest.state === 1 && (
                <p className='text-sm'>
                  <span className='loading loading-spinner loading-xs mr-2' />
                  {discordTest.message || 'Testing…'}
                </p>
              )}
              {discordTest.state === 2 && (
                <p className='text-sm text-success'>✓ {discordTest.message}</p>
              )}
              {discordTest.state === 3 && (
                <p className='text-sm text-error'>✗ {discordTest.message}</p>
              )}
            </div>

            <div className='form-control'>
              <label htmlFor='gaggibotUrl' className='mb-2 block text-sm font-medium'>
                Gaggibot URL
              </label>
              <input
                id='gaggibotUrl'
                name='gaggibotUrl'
                type='url'
                className='input input-bordered w-full'
                placeholder='http://192.168.1.50:3000'
                value={formData.gaggibotUrl ?? ''}
                onChange={onChange('gaggibotUrl')}
              />
              <p className='mt-1 text-xs opacity-60'>
                Base URL of the Docker container as reachable from this display. Save & Restart
                after changing modes.
              </p>
            </div>

            {formData.gaggibotUrl && (
              <div className='space-y-4'>
                <div className='form-control'>
                  <label htmlFor='gaggibotToken' className='mb-2 block text-sm font-medium'>
                    Bridge access token
                  </label>
                  <div className='join w-full'>
                    <input
                      id='gaggibotToken'
                      name='gaggibotToken'
                      type={showGaggibotToken ? 'text' : 'password'}
                      className='input input-bordered join-item w-full'
                      placeholder='Same value as GAGGIBOT_SHARED_TOKEN in Docker'
                      value={formData.gaggibotToken ?? ''}
                      onChange={onChange('gaggibotToken')}
                    />
                    <button
                      type='button'
                      className='btn btn-neutral join-item'
                      onClick={() => setShowGaggibotToken(!showGaggibotToken)}
                      aria-label={showGaggibotToken ? 'Hide bridge token' : 'Show bridge token'}
                    >
                      <FontAwesomeIcon icon={showGaggibotToken ? faEyeSlash : faEye} />
                    </button>
                  </div>
                </div>
                <div className='form-control'>
                  <label htmlFor='gaggibotDeviceId' className='mb-2 block text-sm font-medium'>
                    Device ID (optional)
                  </label>
                  <input
                    id='gaggibotDeviceId'
                    name='gaggibotDeviceId'
                    type='text'
                    className='input input-bordered w-full'
                    placeholder='Empty uses gaggimate-&lt;Wi-Fi MAC&gt;'
                    value={formData.gaggibotDeviceId ?? ''}
                    onChange={onChange('gaggibotDeviceId')}
                  />
                </div>
              </div>
            )}

            {!formData.gaggibotUrl && <>
            <div className='form-control'>
              <label htmlFor='discordBotToken' className='mb-2 block text-sm font-medium'>
                Bot Token
              </label>
              <div className='join w-full'>
                <input
                  id='discordBotToken'
                  name='discordBotToken'
                  type={showDiscordToken ? 'text' : 'password'}
                  className='input input-bordered join-item w-full'
                  placeholder='Bot token'
                  value={formData.discordBotToken}
                  onChange={onChange('discordBotToken')}
                />
                <button
                  type='button'
                  className='btn btn-neutral join-item'
                  onClick={() => setShowDiscordToken(!showDiscordToken)}
                  aria-label={showDiscordToken ? 'Hide bot token' : 'Show bot token'}
                >
                  <FontAwesomeIcon icon={showDiscordToken ? faEyeSlash : faEye} />
                </button>
              </div>
            </div>

            <div className='form-control'>
              <label className='mb-2 block text-sm font-medium'>Users</label>
              <div className='space-y-2'>
                {discordUsers.map((user, index) => (
                  <div key={index} className='flex items-center gap-2'>
                    <input
                      type='text'
                      className='input input-bordered w-full'
                      placeholder='Discord User ID'
                      value={user.id}
                      onChange={e => updateDiscordUser(index, { id: e.currentTarget.value })}
                      aria-label={`Discord user ${index + 1} ID`}
                    />
                    <input
                      type='checkbox'
                      className='toggle toggle-primary'
                      checked={user.enabled}
                      onChange={e =>
                        updateDiscordUser(index, { enabled: e.currentTarget.checked })
                      }
                      aria-label={`Enable Discord user ${index + 1}`}
                    />
                    <button
                      type='button'
                      className='btn btn-ghost btn-sm'
                      onClick={() => removeDiscordUser(index)}
                      aria-label={`Remove Discord user ${index + 1}`}
                    >
                      <FontAwesomeIcon icon={faTrashCan} />
                    </button>
                  </div>
                ))}
                <button
                  type='button'
                  className='btn btn-primary btn-sm'
                  onClick={addDiscordUser}
                  aria-label='Add user'
                >
                  Add user
                </button>
              </div>
            </div>

            <div className='form-control'>
              <label className='mb-2 block text-sm font-medium'>Include in message</label>
              <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
                {DISCORD_FIELD_OPTIONS.map(option => (
                  <label key={option.bit} className='flex items-center gap-2 text-sm'>
                    <input
                      type='checkbox'
                      className='checkbox'
                      checked={(discordFieldsValue & option.bit) !== 0}
                      onChange={() => toggleDiscordField(option.bit)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
              <div className='flex items-center justify-between'>
                <span className='text-lg font-medium'>AI Reply Parsing</span>
                <input
                  id='discordAi'
                  name='discordAi'
                  value='discordAi'
                  type='checkbox'
                  className='toggle toggle-primary'
                  checked={!!formData.discordAi}
                  onChange={onChange('discordAi')}
                  aria-label='Enable AI Reply Parsing'
                />
              </div>
              {formData.discordAi && (
                <div className='space-y-4'>
                  <p className='text-sm opacity-70'>
                    Use any OpenAI-compatible chat endpoint to parse free-text replies into
                    structured rating, grind size, doses, bean and notes fields.
                  </p>
                  <div className='form-control'>
                    <label htmlFor='discordAiUrl' className='mb-2 block text-sm font-medium'>
                      API URL
                    </label>
                    <input
                      id='discordAiUrl'
                      name='discordAiUrl'
                      type='text'
                      className='input input-bordered w-full'
                      placeholder='https://api.openai.com/v1/chat/completions'
                      value={formData.discordAiUrl}
                      onChange={onChange('discordAiUrl')}
                    />
                  </div>
                  <div className='form-control'>
                    <label htmlFor='discordAiKey' className='mb-2 block text-sm font-medium'>
                      API Key
                    </label>
                    <div className='join w-full'>
                      <input
                        id='discordAiKey'
                        name='discordAiKey'
                        type={showDiscordAiKey ? 'text' : 'password'}
                        className='input input-bordered join-item w-full'
                        placeholder='API key'
                        value={formData.discordAiKey}
                        onChange={onChange('discordAiKey')}
                      />
                      <button
                        type='button'
                        className='btn btn-neutral join-item'
                        onClick={() => setShowDiscordAiKey(!showDiscordAiKey)}
                        aria-label={showDiscordAiKey ? 'Hide API key' : 'Show API key'}
                      >
                        <FontAwesomeIcon icon={showDiscordAiKey ? faEyeSlash : faEye} />
                      </button>
                    </div>
                  </div>
                  <div className='form-control'>
                    <label htmlFor='discordAiModel' className='mb-2 block text-sm font-medium'>
                      Model
                    </label>
                    <input
                      id='discordAiModel'
                      name='discordAiModel'
                      type='text'
                      className='input input-bordered w-full'
                      placeholder='gpt-4o-mini'
                      value={formData.discordAiModel}
                      onChange={onChange('discordAiModel')}
                    />
                  </div>
                </div>
              )}
            </div>
            </>}
          </div>
        )}
      </div>

      {gearpumpAddon.value && (
        <div className='bg-base-200 rounded-lg p-4'>
          <div className='flex items-center justify-between'>
            <span className='text-xl font-medium'>BLDC Pump Settings</span>
          </div>
          <div className='border-base-300 mt-4 space-y-4 border-t pt-4'>
            <p className='text-sm opacity-70'>
              The BLDC pump addon was detected in your system. You can change the pump control
              characteristics using the values below.
            </p>

            <div className='form-control'>
              <label htmlFor='commutationGain' className='mb-2 block text-sm font-medium'>
                Commutation Gain
              </label>
              <input
                id='commutationGain'
                name='commutationGain'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                min='0'
                max='100'
                step='any'
                value={formData.commutationGain?.toString()}
                onChange={onChange('commutationGain')}
              />
            </div>

            <div className='form-control'>
              <label htmlFor='convergenceGain' className='mb-2 block text-sm font-medium'>
                Convergence Gain
              </label>
              <input
                id='convergenceGain'
                name='convergenceGain'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                min='0'
                max='100'
                step='any'
                value={formData.convergenceGain?.toString()}
                onChange={onChange('convergenceGain')}
              />
            </div>

            <div className='form-control'>
              <label htmlFor='integralGain' className='mb-2 block text-sm font-medium'>
                Integral Gain
              </label>
              <input
                id='integralGain'
                name='integralGain'
                type='number'
                className='input input-bordered w-full'
                placeholder='0'
                min='0'
                max='100'
                step='any'
                value={formData.integralGain?.toString()}
                onChange={onChange('integralGain')}
              />
            </div>
            <div className='form-control'>
              <label htmlFor='maxPumpPower' className='mb-2 block text-sm font-medium'>
                Maximum Pump Power (0 - 1)
              </label>
              <input
                id='maxPumpPower'
                name='maxPumpPower'
                type='number'
                placeholder='0'
                min='0'
                max='1'
                step='any'
                className='input input-bordered w-full'
                value={formData.maxPumpPower?.toString()}
                onChange={onChange('maxPumpPower')}
              />
            </div>
            <div className='form-control'>
              <label htmlFor='pumpSlipCoeffs' className='mb-2 block text-sm font-medium'>
                Pump Slip Coefficients
              </label>
              <input
                id='pumpSlipCoeffs'
                name='pumpSlipCoeffs'
                type='text'
                className='input input-bordered w-full'
                placeholder='0,0,0,0'
                value={formData.pumpSlipCoeffs}
                onChange={onChange('pumpSlipCoeffs')}
              />
              <span className='mt-1 text-xs opacity-70'>
                Pressure polynomial (a,b,c,d) for vane-/gear-pump internal leakage. Leave at 0,0,0,0
                if uncalibrated.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
